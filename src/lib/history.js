/**
 * Completed-scan history.
 *
 * Rows are stored flat, one per (scan, sortMode, gig), with a `country` field that
 * is always null for now. That is deliberate: the premium per-country tracker adds
 * rows on the same shape, so no migration is needed when it lands.
 */

import { summarizeBySortMode } from './extract.js';

export const HISTORY_KEY = 'scanHistory';
export const MAX_HISTORY_ENTRIES = 500;

export function scanToHistoryEntry(scan) {
  const summary = summarizeBySortMode(scan);
  const rows = [];

  for (const modeId of scan.sortModes) {
    const modeSummary = summary[modeId];
    if (modeSummary.found) {
      for (const finding of modeSummary.all) {
        rows.push({
          sortMode: modeId,
          country: null,
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
        country: null,
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
 * Position over time for one (keyword, username, sortMode), oldest first.
 * Entries where the gig was not found are kept with position null so a drop out
 * of the tracked pages is visible rather than silently missing from the trend.
 */
export async function trendFor({ keyword, username, sortMode }) {
  const history = await listHistory();
  return history
    .filter((e) => e.keyword === keyword && e.username === username)
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
