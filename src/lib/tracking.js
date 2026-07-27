/**
 * Daily rank tracking, in the user's own browser.
 *
 * Server-side scanning was defeated by Fiverr's bot protection — five attempts
 * across a clean fingerprint, human pacing and a residential proxy produced
 * inconsistent results, which is worse than none for something people pay for.
 * The extension already scans reliably because it *is* a real browser with a real
 * profile, so tracking runs there instead.
 *
 * The trade is honest and worth stating: a scan only happens when the browser is
 * open, and it sees the user's own country. In exchange it cannot be blocked and
 * costs nothing to run.
 *
 * Everything here is pure so the scheduling rules can be tested without a browser.
 */

export const TRACKED_KEY = 'trackedKeywords';
export const HISTORY_KEY = 'rankHistory';

/** Roughly daily. Not exactly 24h, so a browser opened at the same time each day
 *  does not drift into never being due. */
export const RUN_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** Six months of daily points is plenty to see a trend, and bounds storage. */
export const MAX_HISTORY_POINTS = 190;

const DAY_MS = 24 * 60 * 60 * 1000;

export function makeTrackedKeyword({ keyword, username, sortModes, now = Date.now() }) {
  return {
    id: `trk_${now}_${Math.random().toString(36).slice(2, 8)}`,
    keyword: String(keyword || '').trim(),
    username: String(username || '').trim().toLowerCase(),
    sortModes: sortModes?.length ? [...sortModes] : ['relevance'],
    createdAt: now,
    lastRunAt: null,
  };
}

/** Same keyword and seller twice is a duplicate, whatever the sort modes. */
export function isDuplicate(list, { keyword, username }) {
  const k = String(keyword || '').trim().toLowerCase();
  const u = String(username || '').trim().toLowerCase();
  return (list || []).some(
    (item) => item.keyword.toLowerCase() === k && item.username.toLowerCase() === u,
  );
}

/**
 * @param {number} limit From the plan's `features.trackedKeywords`.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function canTrackMore(list, limit) {
  const count = (list || []).length;
  if (!limit) {
    return {
      allowed: false,
      reason: 'Daily tracking is a paid feature — upgrade to track keywords automatically.',
    };
  }
  if (count >= limit) {
    return {
      allowed: false,
      reason: `Your plan tracks ${limit} keyword${limit === 1 ? '' : 's'}. Remove one, or upgrade.`,
    };
  }
  return { allowed: true };
}

/** Which tracked keywords are due for a scan. */
export function dueForScan(list, now = Date.now()) {
  return (list || []).filter((item) => !item.lastRunAt || now - item.lastRunAt >= RUN_INTERVAL_MS);
}

/**
 * Append a data point, keeping one per day per sort mode.
 *
 * Re-running on the same day replaces that day's entry rather than adding a
 * second: two points for one day would make a chart imply movement that never
 * happened.
 */
export function appendHistory(history, trackedId, point, now = Date.now()) {
  const next = { ...(history || {}) };
  const series = [...(next[trackedId] || [])];
  const day = new Date(point.at ?? now).toISOString().slice(0, 10);

  const existing = series.findIndex(
    (p) => p.sortMode === point.sortMode && new Date(p.at).toISOString().slice(0, 10) === day,
  );

  const entry = { at: point.at ?? now, ...point };
  if (existing >= 0) series[existing] = entry;
  else series.push(entry);

  series.sort((a, b) => a.at - b.at);
  next[trackedId] = series.slice(-MAX_HISTORY_POINTS);
  return next;
}

/**
 * Movement between the two most recent points for a sort mode.
 *
 * Positive means improved — a rise from #30 to #12 is +18 — because "up" meaning
 * "number went down" is the kind of thing people misread on a dashboard.
 */
export function rankDelta(series, sortMode) {
  const points = (series || []).filter((p) => p.sortMode === sortMode);
  if (points.length < 2) return null;

  const [previous, latest] = points.slice(-2);
  if (!latest.found && !previous.found) return null;
  // Entering or leaving the tracked range is a change, but not a measurable
  // number of places.
  if (!latest.found) return { direction: 'lost', places: null, from: previous.position };
  if (!previous.found) return { direction: 'entered', places: null, to: latest.position };

  const places = previous.position - latest.position;
  return {
    direction: places > 0 ? 'up' : places < 0 ? 'down' : 'flat',
    places: Math.abs(places),
    from: previous.position,
    to: latest.position,
  };
}

/** Latest known position per sort mode, for the summary row. */
export function latestPositions(series) {
  const out = {};
  for (const point of series || []) out[point.sortMode] = point;
  return out;
}

/** Points within the window, for a sparkline. */
export function recentSeries(series, days = 30, now = Date.now()) {
  const cutoff = now - days * DAY_MS;
  return (series || []).filter((p) => p.at >= cutoff);
}
