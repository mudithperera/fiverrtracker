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

export const SORT_MODES = [
  {
    id: 'relevance',
    label: 'Relevance',
    // Relevance is Fiverr's default: no sort parameter at all.
    fallback: {},
    match: /relevance/i,
  },
  {
    id: 'best_selling',
    label: 'Best Selling',
    fallback: { sort_by: 'best_selling' },
    match: /best[\s_-]*selling/i,
  },
  {
    id: 'new_arrivals',
    label: 'New Arrivals',
    fallback: { sort_by: 'new_arrivals' },
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
 * @returns {{ source: 'calibrated'|'fallback', capturedAt: number|null,
 *             params: Record<string, Record<string,string>> }}
 */
export function fallbackCalibration() {
  const params = {};
  for (const mode of SORT_MODES) params[mode.id] = { ...mode.fallback };
  return { source: 'fallback', capturedAt: null, params };
}

export async function loadCalibration() {
  const stored = (await chrome.storage.local.get(CALIBRATION_KEY))[CALIBRATION_KEY];
  if (!stored || !stored.params) return fallbackCalibration();

  // Every mode must be present, otherwise the cache is from an older shape.
  for (const id of SORT_MODE_IDS) {
    if (!stored.params[id]) return fallbackCalibration();
  }
  if (stored.capturedAt && Date.now() - stored.capturedAt > CALIBRATION_MAX_AGE_MS) {
    return { ...stored, stale: true };
  }
  return stored;
}

export async function saveCalibration(params) {
  const record = { source: 'calibrated', capturedAt: Date.now(), params };
  await chrome.storage.local.set({ [CALIBRATION_KEY]: record });
  return record;
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
