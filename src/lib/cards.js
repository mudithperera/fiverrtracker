/**
 * Turns the raw `[data-gig-id]` cards scraped off a Fiverr search page into the
 * organic result list, and explains everything it threw away.
 *
 * Why this exists: the first version of this extension counted every gig-shaped
 * anchor on the page. That silently swept in the header, the category tree, the
 * filter dropdowns, the footer — and, worst of all, a *recommendations row* whose
 * cards are visually identical to real results. Positions came out inflated and a
 * seller appeared to rank once on every single page.
 *
 * The fix is to stop inferring structure from the DOM and read what Fiverr already
 * tells us:
 *
 *   - `data-gig-id="238413205_0"` is `<gigId>_<indexOnPage>`. Fiverr numbers its own
 *     results, so position is a value we read, not one we count.
 *   - Real result links carry a `context_referrer` query param. Navigation chrome
 *     (category tree, filters, pagination, footer) carries none.
 *   - Injected modules carry their own `source` (e.g. `recommendation_ftb_friendly`),
 *     and are always a minority of the cards, so the organic `source` is simply
 *     the dominant one.
 *
 * Everything here is pure so it can be tested against captured page data.
 */

import { parseGigPath } from './extract.js';

/** Fiverr serves 48 results per search page (`&limit=48` on its own pagination links). */
export const EXPECTED_PAGE_SIZE = 48;

/**
 * `source` values that always mean "injected module", regardless of the page URL.
 * This is a backstop for the case where the page URL carries no `source` of its own
 * and the echo comparison therefore has nothing to compare against.
 */
const INJECTED_SOURCE_PATTERN = /recommend|promot|sponsor|_ftb_|advert/i;

const BASE_ORIGIN = 'https://www.fiverr.com';

/**
 * Split a `data-gig-id` into its gig id and its position on the page.
 * @returns {{gigId: string, index: number}|null}
 */
export function parseCardId(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(.+)_(\d+)$/);
  if (!match) return null;
  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { gigId: match[1], index };
}

/** Read one query parameter off a possibly-relative URL. */
export function readParam(href, name) {
  if (typeof href !== 'string') return null;
  try {
    return new URL(href, BASE_ORIGIN).searchParams.get(name);
  } catch {
    return null;
  }
}

/** Pull out everything classification needs from a card's link. */
function readCardHref(href) {
  if (typeof href !== 'string') return null;
  let url;
  try {
    url = new URL(href, BASE_ORIGIN);
  } catch {
    return null;
  }
  return {
    contextReferrer: url.searchParams.get('context_referrer'),
    source: url.searchParams.get('source'),
    pathname: url.pathname,
    // Tracking params churn per page load; strip them so stored URLs stay stable.
    cleanUrl: `${url.origin}${url.pathname}`,
  };
}

/**
 * Decide which scraped cards are real search results.
 *
 * @param {Array<{gigId:string, href:string, title?:string}>} rawCards
 *        One entry per `[data-gig-id]` wrapper, in DOM order.
 * @param {string} pageUrl The search page's own URL, used to learn its `source`.
 * @returns {{
 *   organic: Array<{gigId:string, index:number, username:string, slug:string, url:string, title:string}>,
 *   excluded: Record<string, number>,
 *   warnings: string[],
 *   contiguous: boolean,
 *   pageSource: string|null,
 * }}
 */
export function classifyCards(rawCards, pageUrl) {
  const pageSource = readParam(pageUrl, 'source');
  const excluded = {};
  const bump = (bucket) => {
    excluded[bucket] = (excluded[bucket] || 0) + 1;
  };

  // First pass: drop anything that is not a gig card at all.
  const candidates = [];
  for (const raw of rawCards || []) {
    const id = parseCardId(raw?.gigId);
    if (!id) {
      bump('unreadable-id');
      continue;
    }

    const href = readCardHref(raw?.href);
    if (!href) {
      bump('unreadable-link');
      continue;
    }

    const gig = parseGigPath(href.pathname);
    if (!gig) {
      bump('not-a-gig-link');
      continue;
    }

    // Navigation chrome links have no context_referrer at all.
    if (!href.contextReferrer) {
      bump('no-context-referrer');
      continue;
    }

    candidates.push({ id, href, gig, title: raw.title || '' });
  }

  // The organic results are whichever `source` the bulk of the cards share;
  // injected modules are always a small minority. Deriving this from the cards
  // rather than from the page URL matters, because the URL's own source changes
  // with how the page was reached — sorting sets `source=sorting_by`, paginating
  // sets `pagination` — and gating on it would drop every real result.
  const counts = new Map();
  for (const c of candidates) {
    const key = c.href.source || '';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let dominantSource = '';
  let best = -1;
  for (const [source, count] of counts) {
    if (count > best) {
      best = count;
      dominantSource = source;
    }
  }

  const kept = new Map();
  for (const { id, href, gig, title } of candidates) {
    const source = href.source || '';

    // Belt and braces: a known-injected source is excluded even if it somehow
    // dominates the page.
    if (source && INJECTED_SOURCE_PATTERN.test(source)) {
      bump(source);
      continue;
    }
    if (source !== dominantSource) {
      bump(source || 'no-source');
      continue;
    }

    const existing = kept.get(id.gigId);
    if (existing) {
      // Nested wrappers can repeat a gig; keep the most descriptive title.
      if (title.length > (existing.title || '').length) existing.title = title;
      continue;
    }

    kept.set(id.gigId, {
      gigId: id.gigId,
      pageIndex: id.index,
      username: gig.username,
      slug: gig.slug,
      url: href.cleanUrl,
      title,
    });
  }

  // Fiverr numbers every card in the grid, injected ones included, so its index is
  // an ordering key — not a rank. A gig sitting after a promoted card would be
  // reported one slot too low if we used the raw index. Rank the survivors instead.
  const organic = Array.from(kept.values())
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((card, i) => ({ ...card, position: i + 1 }));

  const warnings = [];
  const excludedCount = Object.values(excluded).reduce((sum, n) => sum + n, 0);
  const highestIndex = organic.length ? organic[organic.length - 1].pageIndex : -1;
  // Every hole in Fiverr's numbering should be explained by something we filtered.
  // More holes than exclusions means we dropped a real result, which would shift
  // every position after it.
  const unexplainedGaps = highestIndex + 1 - organic.length - excludedCount;
  const contiguous = unexplainedGaps <= 0;

  if (!contiguous) {
    warnings.push(
      `${unexplainedGaps} result${unexplainedGaps === 1 ? '' : 's'} on this page could not be ` +
        `read (Fiverr numbered ${highestIndex + 1} cards, ${organic.length} were usable). ` +
        'Positions after the gap may be too low.',
    );
  }

  return { organic, excluded, warnings, contiguous, pageSource, dominantSource };
}

/** Compact "0-12, 14-47" style description of what indices survived, for diagnostics. */
export function describeIndices(cards) {
  const indices = cards.map((c) => c.pageIndex ?? c.index);
  if (!indices.length) return 'none';
  const runs = [];
  let start = indices[0];
  let prev = indices[0];
  for (const value of indices.slice(1)) {
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    runs.push([start, prev]);
    start = value;
    prev = value;
  }
  runs.push([start, prev]);
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/**
 * Buckets that are just ordinary page furniture — nav, filters, footer. Every page
 * has dozens and reporting them would bury the interesting case.
 */
const STRUCTURAL_BUCKETS = new Set([
  'unreadable-id',
  'unreadable-link',
  'not-a-gig-link',
  'no-context-referrer',
]);

/**
 * Exclusions worth showing a user: gig cards Fiverr injected into the results
 * (recommendations, promoted placements) rather than page chrome.
 */
export function injectedExclusions(excluded) {
  const out = {};
  for (const [bucket, count] of Object.entries(excluded || {})) {
    if (STRUCTURAL_BUCKETS.has(bucket)) continue;
    out[bucket] = count;
  }
  return out;
}

/** Human-readable one-liner for the exclusion buckets, e.g. "4 recommendation_ftb_friendly". */
export function describeExclusions(excluded) {
  const entries = Object.entries(excluded || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  return entries.map(([bucket, count]) => `${count} ${bucket}`).join(', ');
}
