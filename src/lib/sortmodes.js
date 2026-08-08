/**
 * Fiverr sort modes.
 *
 * Fiverr does not publicly document the query parameter behind its sort dropdown,
 * and it has changed in the past. Rather than hardcode a guess, we calibrate once
 * against the live site (see background.js `runCalibration`) and cache the result.
 * The `fallback` values below are only used when calibration fails, and when they
 * are used the UI shows a warning so a wrong guess can never be silently reported
 * as "gig not found".
 */

export const SEARCH_BASE = 'https://www.fiverr.com/search/gigs';

/**
 * Fiverr's sort parameter is `filter`, observed 2026-07 by picking each option and
 * reading the resulting URL:
 *
 *   Relevance        → filter=auto
 *   Best selling     → filter=rating
 *   Newest arrivals  → filter=new
 *
 * These are still only *defaults*. Calibration re-derives them from the live site,
 * and every scanned page is checked against Fiverr's own sort control, so if these
 * values go stale the extension says so rather than quietly reporting Relevance
 * results under another name.
 */
export const SORT_MODES = [
  {
    id: 'relevance',
    label: 'Relevance',
    fallback: { filter: 'auto' },
    match: /relevance/i,
  },
  {
    id: 'best_selling',
    label: 'Best Selling',
    fallback: { filter: 'rating' },
    match: /best[\s_-]*selling/i,
  },
  {
    id: 'new_arrivals',
    label: 'New Arrivals',
    fallback: { filter: 'new' },
    match: /new(?:est)?[\s_-]*arrivals?/i,
  },
];

export const SORT_MODE_IDS = SORT_MODES.map((m) => m.id);

export const CALIBRATION_KEY = 'sortCalibration';

/** Re-calibrate if the cached map is older than this. */
export const CALIBRATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getSortMode(id) {
  return SORT_MODES.find((m) => m.id === id) || null;
}

export function sortModeLabel(id) {
  return getSortMode(id)?.label || id;
}

/**
 * How to describe a mode whose pages Fiverr sorted by something else.
 *
 * Kept here rather than built in the renderer so the wording is testable, and
 * because it is the one message in the panel that must not drift: the positions
 * it describes are real, correctly read, and attached to the wrong label. A user
 * who acts on a Best Selling rank that was never Best Selling has been misled by
 * us, not by Fiverr.
 *
 * @returns {string|null} null when there is nothing wrong to describe.
 */
export function describeSortMismatch(modeId, actualModeId) {
  if (!actualModeId || actualModeId === modeId) return null;
  const asked = sortModeLabel(modeId);
  const actual = sortModeLabel(actualModeId);
  return (
    `Fiverr sorted these pages by ${actual}, not ${asked}. ` +
    `Treat the positions below as ${actual} — recalibrate in the menu to fix it.`
  );
}

/**
 * Per-mode calibration outcome.
 *
 * `confirmed` means we loaded the mode's URL and saw it return a *different* first
 * page than Relevance — i.e. the parameter demonstrably works. `unconfirmed` means
 * we are falling back to a guess, which the UI must say out loud.
 */
export const MODE_CONFIRMED = 'confirmed';
export const MODE_UNCONFIRMED = 'unconfirmed';

/**
 * @returns {{ source: 'calibrated'|'fallback', capturedAt: number|null,
 *             params: Record<string, Record<string,string>>,
 *             status: Record<string, 'confirmed'|'unconfirmed'> }}
 */
export function fallbackCalibration() {
  const params = {};
  const status = {};
  for (const mode of SORT_MODES) {
    params[mode.id] = { ...mode.fallback };
    // Relevance is Fiverr's default ordering and sets no parameter, so there is
    // nothing to get wrong about it.
    status[mode.id] = mode.id === 'relevance' ? MODE_CONFIRMED : MODE_UNCONFIRMED;
  }
  return { source: 'fallback', capturedAt: null, params, status };
}

export async function loadCalibration() {
  const stored = (await chrome.storage.local.get(CALIBRATION_KEY))[CALIBRATION_KEY];
  if (!stored || !stored.params) return fallbackCalibration();

  // Every mode must be present, otherwise the cache is from an older shape.
  for (const id of SORT_MODE_IDS) {
    if (!stored.params[id]) return fallbackCalibration();
  }

  // Records saved before per-mode status existed have no proof either way, so
  // treat them as unconfirmed rather than quietly claiming they were verified.
  const status = { ...(stored.status || {}) };
  for (const id of SORT_MODE_IDS) {
    if (status[id] !== MODE_CONFIRMED) {
      status[id] = id === 'relevance' ? MODE_CONFIRMED : MODE_UNCONFIRMED;
    }
  }
  const record = { ...stored, status };

  if (stored.capturedAt && Date.now() - stored.capturedAt > CALIBRATION_MAX_AGE_MS) {
    return { ...record, stale: true };
  }
  return record;
}

export async function saveCalibration(params, status) {
  const record = {
    source: 'calibrated',
    capturedAt: Date.now(),
    params,
    status: status || {},
  };
  await chrome.storage.local.set({ [CALIBRATION_KEY]: record });
  return record;
}

/** True when at least one non-default sort mode is still running on a guess. */
export function hasUnconfirmedModes(calibration) {
  const status = calibration?.status || {};
  return SORT_MODE_IDS.some((id) => id !== 'relevance' && status[id] !== MODE_CONFIRMED);
}

export async function clearCalibration() {
  await chrome.storage.local.remove(CALIBRATION_KEY);
}

/**
 * Build a Fiverr search URL for a keyword / page / sort mode.
 *
 * `page=1` is emitted without the page param because Fiverr's own first page has
 * no `page` in the URL, and including it has been observed to change behaviour.
 */
export function buildSearchUrl(keyword, page, sortModeId, calibration) {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set('query', keyword);
  url.searchParams.set('source', 'top-bar');
  url.searchParams.set('search_in', 'everywhere');
  if (page > 1) url.searchParams.set('page', String(page));

  const sortParams = calibration?.params?.[sortModeId] ?? getSortMode(sortModeId)?.fallback ?? {};
  for (const [key, value] of Object.entries(sortParams)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Diff a post-click URL against the baseline to work out which parameters the
 * sort dropdown actually sets. Page/tracking params are ignored so calibration
 * captures only the sort dimension.
 */
const CALIBRATION_IGNORED_PARAMS = new Set([
  'query',
  'source',
  'search_in',
  'page',
  'ref_ctx_id',
  'search-autocomplete-original-term',
  'search-autocomplete-available',
  'search-autocomplete-api-used',
  'search_ac_available',
  'context_referrer',
  'pos',
  'context',
  'context_type',
  'imp_id',
]);

export function diffSortParams(baselineUrl, candidateUrl) {
  const base = new URL(baselineUrl).searchParams;
  const next = new URL(candidateUrl).searchParams;
  const diff = {};
  for (const [key, value] of next.entries()) {
    if (CALIBRATION_IGNORED_PARAMS.has(key)) continue;
    if (base.get(key) === value) continue;
    diff[key] = value;
  }
  return diff;
}
