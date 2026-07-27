/**
 * The single source of truth for an in-flight scan.
 *
 * A scan drives the user's tab through up to (sort modes x pages) navigations.
 * Every navigation destroys the content script, and the MV3 service worker can be
 * evicted at any point, so the whole cursor lives in chrome.storage.local and is
 * written after every page. Nothing that matters is held in memory.
 */

export const ACTIVE_SCAN_KEY = 'activeScan';

export const SCAN_STATUS = {
  RUNNING: 'running',
  PAUSED: 'paused',
  BLOCKED: 'blocked', // Fiverr bot-check in the way; user must intervene, cursor kept
  DONE: 'done',
  ERROR: 'error',
};

export const CALIBRATING = 'calibrating';

let writeChain = Promise.resolve();

export function createScan({ keyword, username, rawUsername, maxPages, delayMs, sortModes, tabId }) {
  const progress = {};
  for (const id of sortModes) {
    progress[id] = { pagesScanned: 0, gigsSeen: 0, exhausted: false };
  }
  return {
    id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    keyword,
    username,
    rawUsername,
    maxPages,
    delayMs,
    sortModes,
    tabId,
    cursor: { sortIndex: 0, page: 1 },
    status: SCAN_STATUS.RUNNING,
    findings: [],
    warnings: [],
    log: [],
    calibrationSource: null,
    consecutiveEmptyPages: 0,
    startedAt: Date.now(),
    finishedAt: null,
    progress,
  };
}

export async function loadScan() {
  const stored = await chrome.storage.local.get(ACTIVE_SCAN_KEY);
  return stored[ACTIVE_SCAN_KEY] || null;
}

export async function saveScan(scan) {
  await chrome.storage.local.set({ [ACTIVE_SCAN_KEY]: scan });
  return scan;
}

export async function clearScan() {
  await chrome.storage.local.remove(ACTIVE_SCAN_KEY);
}

/**
 * Serialized read-modify-write. The orchestrator and the message handlers both
 * mutate the scan (Stop can land mid-page), so unsynchronized read/write would
 * lose the pause.
 */
export function patchScan(mutate) {
  writeChain = writeChain.then(async () => {
    const scan = await loadScan();
    if (!scan) return null;
    const next = (await mutate(scan)) || scan;
    await saveScan(next);
    return next;
  });
  return writeChain;
}

export const MAX_LOG_ENTRIES = 200;

export function appendLog(scan, level, message) {
  scan.log.push({ at: Date.now(), level, message });
  if (scan.log.length > MAX_LOG_ENTRIES) {
    scan.log.splice(0, scan.log.length - MAX_LOG_ENTRIES);
  }
  return scan;
}

export function addWarning(scan, message) {
  if (!scan.warnings.includes(message)) scan.warnings.push(message);
  return scan;
}

export function isTerminal(status) {
  return status === SCAN_STATUS.DONE || status === SCAN_STATUS.ERROR;
}

/**
 * Advance the cursor past the current page. Returns false when every selected sort
 * mode is finished.
 *
 * `exhaustCurrentMode` is set when Fiverr ran out of results (or clamped the page
 * number), so we skip straight to the next mode instead of burning the remaining
 * page loads on empty results.
 */
export function advanceCursor(scan, { exhaustCurrentMode = false } = {}) {
  const modeId = scan.sortModes[scan.cursor.sortIndex];
  if (exhaustCurrentMode && modeId) scan.progress[modeId].exhausted = true;

  const atLastPage = scan.cursor.page >= scan.maxPages;
  if (exhaustCurrentMode || atLastPage) {
    scan.cursor = { sortIndex: scan.cursor.sortIndex + 1, page: 1 };
  } else {
    scan.cursor = { sortIndex: scan.cursor.sortIndex, page: scan.cursor.page + 1 };
  }
  scan.consecutiveEmptyPages = 0;
  return scan.cursor.sortIndex < scan.sortModes.length;
}
