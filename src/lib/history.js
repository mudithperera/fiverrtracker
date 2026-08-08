/**
 * Completed-scan history.
 *
 * Rows are stored flat, one per (scan, sortMode, gig), carrying the country the
 * scan was actually routed through — `null` for a scan run from the user's own
 * location, which is also what every row written before this existed reads as.
 *
 * The value comes from `scan.routedCountry`, which the worker writes only after
 * the proxy is in force, and never from the country that was *asked* for. A row
 * claiming to be Germany when the route never came up would be undetectable
 * afterwards and would poison every trend built on top of it.
 */

import { summarizeBySortMode } from './extract.js';

export const HISTORY_KEY = 'scanHistory';
export const MAX_HISTORY_ENTRIES = 500;

export function scanToHistoryEntry(scan) {
  const summary = summarizeBySortMode(scan);
  const rows = [];
  const country = scan.routedCountry || null;

  for (const modeId of scan.sortModes) {
    const modeSummary = summary[modeId];
    if (modeSummary.found) {
      for (const finding of modeSummary.all) {
        rows.push({
          sortMode: modeId,
          country,
          found: true,
          page: finding.page,
          positionOnPage: finding.positionOnPage,
          absolutePosition: finding.absolutePosition,
          gigTitle: finding.gigTitle,
          gigUrl: finding.gigUrl,
        });
      }
    } else {
      rows.push({
        sortMode: modeId,
        country,
        found: false,
        page: null,
        positionOnPage: null,
        absolutePosition: null,
        gigTitle: null,
        gigUrl: null,
        pagesScanned: modeSummary.pagesScanned,
      });
    }
  }

  return {
    id: scan.id,
    keyword: scan.keyword,
    username: scan.username,
    sortModes: scan.sortModes,
    maxPages: scan.maxPages,
    country,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt || Date.now(),
    warnings: scan.warnings || [],
    calibrationSource: scan.calibrationSource,
    rows,
  };
}

export async function listHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return stored[HISTORY_KEY] || [];
}

export async function appendScan(scan) {
  const entry = scanToHistoryEntry(scan);
  const history = await listHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY_ENTRIES) history.length = MAX_HISTORY_ENTRIES;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
  return entry;
}

export async function clearHistory() {
  await chrome.storage.local.remove(HISTORY_KEY);
}

/**
 * Position over time for one (keyword, username, sortMode, country), oldest first.
 * Entries where the gig was not found are kept with position null so a drop out
 * of the tracked pages is visible rather than silently missing from the trend.
 *
 * `country` is part of the series identity, not a filter bolted on: the same
 * keyword ranks differently in every country, so a trend that mixed them would
 * show swings that are really just the route changing between runs. Omitting it
 * means the user's own location — the only series that existed before countries
 * were recorded, so old history keeps reading the same way.
 */
export async function trendFor({ keyword, username, sortMode, country = null }) {
  const history = await listHistory();
  return history
    .filter(
      (e) =>
        e.keyword === keyword &&
        e.username === username &&
        (e.country ?? null) === (country ?? null),
    )
    .map((entry) => {
      const matching = entry.rows.filter((r) => r.sortMode === sortMode);
      const best = matching
        .filter((r) => r.found)
        .reduce((a, b) => (a === null || b.absolutePosition < a.absolutePosition ? b : a), null);
      return {
        at: entry.finishedAt,
        absolutePosition: best ? best.absolutePosition : null,
        page: best ? best.page : null,
      };
    })
    .reverse();
}
