/**
 * Scan orchestrator (MV3 service worker).
 *
 * Owns the whole scan state machine. The panel is a renderer that sends commands
 * and reads state back out of chrome.storage; it never holds scan state, because
 * the scan outlives any single page and the panel can be closed at any time.
 */

import {
  MODE_CONFIRMED,
  MODE_UNCONFIRMED,
  SORT_MODES,
  SORT_MODE_IDS,
  buildSearchUrl,
  diffSortParams,
  loadCalibration,
  saveCalibration,
  clearCalibration,
  fallbackCalibration,
  sortModeLabel,
} from './lib/sortmodes.js';
import { matchCards, normalizeUsername, pageSignature } from './lib/extract.js';
import { classifyCards } from './lib/cards.js';
import {
  SCAN_STATUS,
  addWarning,
  advanceCursor,
  appendLog,
  clearScan,
  createScan,
  loadScan,
  patchScan,
  saveScan,
} from './lib/scan-state.js';
import { appendScan, clearHistory, listHistory } from './lib/history.js';
import { canStartScan, consumeCheck, getEntitlement, resetChecks, setPlan } from './lib/entitlements.js';

const NAVIGATION_TIMEOUT_MS = 45000;
const CONTENT_TIMEOUT_MS = 25000;
const CALIBRATION_KEYWORD = 'logo design';
const MAX_PAGE_RETRIES = 1;
/** Back off when Fiverr starts returning slow/empty pages rather than hammering it. */
const BACKOFF_STEP_MS = 1500;
const MAX_BACKOFF_MS = 8000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let loopRunning = false;
let keepAliveTimer = null;

// --- service worker lifetime -------------------------------------------------

/**
 * MV3 evicts an idle worker after ~30s. A running scan calls extension APIs every
 * couple of seconds anyway, but the inter-page delay is user-configurable and can
 * be long, so hold the worker with a cheap periodic API call while scanning.
 */
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.storage.local.get('keepAlive').catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  resumeIfRunning();
});

// Also runs on every worker wake, which is the case that actually matters: if the
// worker was evicted mid-scan, the persisted cursor lets us pick straight back up.
resumeIfRunning();

async function resumeIfRunning() {
  const scan = await loadScan();
  if (scan && scan.status === SCAN_STATUS.RUNNING) runLoop();
}

// --- tab + content script plumbing -------------------------------------------

async function resolveTargetTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && /^https:\/\/(www\.)?fiverr\.com\//.test(active.url || '')) {
    return active.id;
  }
  // Don't hijack a non-Fiverr tab the user is using.
  const created = await chrome.tabs.create({ url: 'https://www.fiverr.com/', active: true });
  return created.id;
}

async function navigateAndWait(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
  await sleep(300);
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('tab-closed');
    }
    if (tab.status === 'complete') return tab;
    await sleep(250);
  }
  throw new Error('navigation-timeout');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || 'timeout')), ms)),
  ]);
}

/**
 * Message the content script, injecting it first if the page loaded before the
 * extension did (or after an extension reload, when the declared script is not
 * present in already-open tabs).
 */
async function sendToContent(tabId, message, timeoutMs = CONTENT_TIMEOUT_MS) {
  try {
    return await withTimeout(chrome.tabs.sendMessage(tabId, message), timeoutMs, 'content-timeout');
  } catch (error) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    } catch (injectError) {
      throw new Error(`content-unreachable: ${injectError.message || injectError}`);
    }
    await sleep(300);
    return withTimeout(chrome.tabs.sendMessage(tabId, message), timeoutMs, 'content-timeout');
  }
}

// --- the scan loop ------------------------------------------------------------

async function runLoop() {
  if (loopRunning) return;
  loopRunning = true;
  startKeepAlive();
  try {
    for (;;) {
      const scan = await loadScan();
      if (!scan || scan.status !== SCAN_STATUS.RUNNING) break;

      if (scan.cursor.sortIndex >= scan.sortModes.length) {
        await finishScan();
        break;
      }

      const keepGoing = await processCurrentPage(scan);
      if (!keepGoing) break;
    }
  } catch (error) {
    await patchScan((scan) => {
      scan.status = SCAN_STATUS.ERROR;
      scan.finishedAt = Date.now();
      appendLog(scan, 'error', `Scan failed: ${error.message || error}`);
      return scan;
    });
  } finally {
    loopRunning = false;
    stopKeepAlive();
  }
}

/** @returns {Promise<boolean>} whether the loop should continue. */
async function processCurrentPage(scan) {
  const modeId = scan.sortModes[scan.cursor.sortIndex];
  const page = scan.cursor.page;
  const calibration = await loadCalibration();
  const url = buildSearchUrl(scan.keyword, page, modeId, calibration);

  await patchScan((s) => appendLog(s, 'info', `${sortModeLabel(modeId)} — scanning page ${page}`));

  let result = null;
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt += 1) {
    try {
      await navigateAndWait(scan.tabId, url);
      result = await sendToContent(scan.tabId, { type: 'EXTRACT' });
      if (result && result.ok) break;
      lastError = new Error(result?.error || 'extract-failed');
    } catch (error) {
      lastError = error;
      if (error.message === 'tab-closed') {
        await patchScan((s) => {
          s.status = SCAN_STATUS.ERROR;
          s.finishedAt = Date.now();
          appendLog(s, 'error', 'The Fiverr tab was closed, so the scan stopped.');
          return s;
        });
        return false;
      }
    }
    if (attempt < MAX_PAGE_RETRIES) await sleep(1500);
  }

  // A pause or stop may have landed while we were mid-page; honour it.
  const current = await loadScan();
  if (!current || current.status !== SCAN_STATUS.RUNNING) return false;

  if (!result || !result.ok) {
    const message = `Could not read ${sortModeLabel(modeId)} page ${page} (${lastError?.message || 'unknown error'}).`;
    await patchScan((s) => {
      appendLog(s, 'warn', message);
      addWarning(s, message);
      s.progress[modeId].pagesScanned += 1;
      advanceCursor(s);
      return s;
    });
    await sleep(scan.delayMs + BACKOFF_STEP_MS);
    return true;
  }

  if (result.botCheck) {
    await patchScan((s) => {
      s.status = SCAN_STATUS.BLOCKED;
      appendLog(
        s,
        'warn',
        'Fiverr showed a human-verification check. Solve it in the tab, then press Resume.',
      );
      return s;
    });
    return false;
  }

  // Fiverr's page carries far more gig-shaped links than actual results —
  // navigation, filters, footer, and an injected recommendations row. classifyCards
  // keeps only the real ones and tells us what it dropped.
  const { organic, excluded, warnings } = classifyCards(result.cards, result.url);
  const signature = pageSignature(organic);
  const previousSignature = scan.progress[modeId].lastSignature || null;

  // Fiverr clamps out-of-range page numbers back to the last real page, which
  // would otherwise look like the same gigs ranking on every remaining page.
  const repeatedPage = Boolean(signature) && signature === previousSignature;
  const emptyPage = organic.length === 0;
  const exhausted = emptyPage || result.noResults || repeatedPage;

  const findings = matchCards(organic, scan.username, {
    sortMode: modeId,
    page,
    positionOffset: scan.progress[modeId].gigsSeen,
  });

  await patchScan((s) => {
    s.progress[modeId].pagesScanned += 1;
    s.progress[modeId].lastSignature = signature;
    if (!repeatedPage) s.progress[modeId].gigsSeen += organic.length;

    // Keep a running tally of what was filtered out, so a future break in
    // classification is visible in the UI instead of silently changing positions.
    const buckets = s.progress[modeId].excluded || (s.progress[modeId].excluded = {});
    for (const [name, count] of Object.entries(excluded)) {
      buckets[name] = (buckets[name] || 0) + count;
    }

    for (const warning of warnings) {
      appendLog(s, 'warn', `${sortModeLabel(modeId)} page ${page}: ${warning}`);
      addWarning(s, warning);
    }

    s.findings.push(...findings);

    for (const finding of findings) {
      appendLog(
        s,
        'hit',
        `Found on ${sortModeLabel(modeId)} — page ${finding.page}, position ${finding.positionOnPage} (#${finding.absolutePosition} overall)`,
      );
    }

    if (result.timedOut && emptyPage) {
      s.consecutiveEmptyPages += 1;
      const message = `No gig cards loaded on ${sortModeLabel(modeId)} page ${page}; Fiverr may be throttling.`;
      appendLog(s, 'warn', message);
      addWarning(s, message);
    }

    if (repeatedPage) {
      appendLog(s, 'info', `${sortModeLabel(modeId)} — no more pages after ${page - 1}.`);
    } else if (exhausted) {
      appendLog(s, 'info', `${sortModeLabel(modeId)} — results ran out at page ${page}.`);
    }

    advanceCursor(s, { exhaustCurrentMode: exhausted });
    return s;
  });

  const after = await loadScan();
  if (!after || after.status !== SCAN_STATUS.RUNNING) return false;
  if (after.cursor.sortIndex >= after.sortModes.length) {
    await finishScan();
    return false;
  }

  const backoff = Math.min(after.consecutiveEmptyPages * BACKOFF_STEP_MS, MAX_BACKOFF_MS);
  await sleep(after.delayMs + backoff);
  return true;
}

async function finishScan() {
  const scan = await patchScan((s) => {
    s.status = SCAN_STATUS.DONE;
    s.finishedAt = Date.now();
    const total = s.findings.length;
    appendLog(
      s,
      'info',
      total
        ? `Finished — ${total} matching gig${total === 1 ? '' : 's'} found.`
        : 'Finished — no gigs matched this search for that username.',
    );
    return s;
  });
  if (!scan) return;
  await appendScan(scan);
  await consumeCheck();
}

// --- calibration --------------------------------------------------------------

export const CALIBRATION_STATE_KEY = 'calibrationState';

async function setCalibrationState(patch) {
  const stored = (await chrome.storage.local.get(CALIBRATION_STATE_KEY))[CALIBRATION_STATE_KEY] || {};
  const next = { ...stored, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [CALIBRATION_STATE_KEY]: next });
  return next;
}

function modePatterns() {
  return SORT_MODES.map((mode) => ({ id: mode.id, label: mode.label, pattern: mode.match.source }));
}

/**
 * Load a search URL and fingerprint its organic results. Returns null if the page
 * could not be read, so callers can tell "different results" from "no answer".
 */
async function resultSignature(tabId, url) {
  await navigateAndWait(tabId, url);
  const result = await sendToContent(tabId, { type: 'EXTRACT' });
  if (!result?.ok || result.botCheck) return null;
  const { organic } = classifyCards(result.cards, result.url);
  return organic.length ? pageSignature(organic) : null;
}

/**
 * Work out which query parameters Fiverr's sort dropdown actually sets, by asking
 * the live page rather than guessing. Preferred path is reading the options' hrefs;
 * if the control is scripted with no hrefs we click each option and diff the URL.
 *
 * Whatever we derive is then *verified*: we load the mode and check it returns a
 * different first page than Relevance. A parameter Fiverr ignores produces
 * identical results, which is indistinguishable from a working sort unless you
 * look — and looking is the whole point, since an ignored parameter silently turns
 * "Best Selling" into a second copy of "Relevance".
 */
async function runCalibration() {
  const tabId = await resolveTargetTab();
  await setCalibrationState({ running: true, error: null, step: 'Opening Fiverr search…' });

  try {
    const baselineUrl = buildSearchUrl(CALIBRATION_KEYWORD, 1, 'relevance', fallbackCalibration());
    const patterns = modePatterns();

    await setCalibrationState({ step: 'Reading Fiverr’s default results…' });
    const baselineSignature = await resultSignature(tabId, baselineUrl);

    await setCalibrationState({ step: 'Reading the sort control…' });
    // The content script waits for hydration and opens the collapsed dropdown
    // before answering, so a miss here means the control genuinely is not there.
    const discovery = await sendToContent(tabId, { type: 'DISCOVER_SORT', modes: patterns });
    const byId = new Map((discovery?.options || []).map((o) => [o.id, o]));

    const params = { relevance: {} };
    const status = { relevance: MODE_CONFIRMED };

    for (const modeId of SORT_MODE_IDS) {
      if (modeId === 'relevance') continue;
      const mode = SORT_MODES.find((m) => m.id === modeId);
      const option = byId.get(modeId);
      let derived = {};

      if (option?.href) {
        derived = diffSortParams(baselineUrl, option.href);
      }

      if (!Object.keys(derived).length) {
        // No usable href — drive the dropdown and read the resulting URL.
        await setCalibrationState({ step: `Checking “${sortModeLabel(modeId)}”…` });
        await navigateAndWait(tabId, baselineUrl);
        const clicked = await sendToContent(tabId, {
          type: 'CLICK_SORT',
          mode: { id: mode.id, pattern: mode.match.source },
          modes: patterns,
        }).catch(() => null);

        let resultUrl = clicked?.ok ? clicked.url : null;
        if (!resultUrl) {
          // A hard navigation kills the content script before it can reply; read
          // the tab's own URL instead.
          await sleep(1500);
          const tab = await chrome.tabs.get(tabId);
          if (tab.url && tab.url !== baselineUrl) resultUrl = tab.url;
        }
        if (resultUrl) derived = diffSortParams(baselineUrl, resultUrl);
      }

      // Fall back to the documented guess rather than giving up on the mode.
      params[modeId] = Object.keys(derived).length ? derived : { ...mode.fallback };

      await setCalibrationState({ step: `Verifying “${sortModeLabel(modeId)}”…` });
      const candidateUrl = buildSearchUrl(CALIBRATION_KEYWORD, 1, modeId, { params });
      const signature = await resultSignature(tabId, candidateUrl).catch(() => null);

      status[modeId] =
        baselineSignature && signature && signature !== baselineSignature
          ? MODE_CONFIRMED
          : MODE_UNCONFIRMED;
    }

    const record = await saveCalibration(params, status);
    const unconfirmed = SORT_MODE_IDS.filter(
      (id) => id !== 'relevance' && status[id] !== MODE_CONFIRMED,
    );
    await setCalibrationState({
      running: false,
      step: null,
      error: null,
      unconfirmed,
      completedAt: record.capturedAt,
    });
    return record;
  } catch (error) {
    await setCalibrationState({
      running: false,
      step: null,
      error: String(error.message || error),
    });
    throw error;
  }
}

// --- commands from the panel --------------------------------------------------

async function startScan(payload) {
  const gate = await canStartScan();
  if (!gate.allowed) return { ok: false, error: gate.reason };

  const keyword = String(payload.keyword || '').trim();
  const username = normalizeUsername(payload.rawUsername);
  if (!keyword) return { ok: false, error: 'Enter a keyword to search for.' };
  if (!username) return { ok: false, error: 'Enter the Fiverr username to look for.' };

  const sortModes = SORT_MODE_IDS.filter((id) => (payload.sortModes || []).includes(id));
  if (!sortModes.length) return { ok: false, error: 'Pick at least one sort order to scan.' };

  const maxPages = Math.min(Math.max(parseInt(payload.maxPages, 10) || 10, 1), 30);
  const delayMs = Math.min(Math.max(Math.round((parseFloat(payload.delaySeconds) || 0.8) * 1000), 300), 15000);

  const tabId = await resolveTargetTab();
  const calibration = await loadCalibration();

  const scan = createScan({
    keyword,
    username,
    rawUsername: payload.rawUsername,
    maxPages,
    delayMs,
    sortModes,
    tabId,
  });
  scan.calibrationSource = calibration.source;
  scan.calibrationStatus = calibration.status || {};

  appendLog(scan, 'info', `Looking for @${username} ranking for “${keyword}”.`);

  // Warn only about the modes actually being scanned — a stale guess for a mode
  // the user did not select is not their problem right now.
  const unverified = sortModes.filter(
    (id) => id !== 'relevance' && calibration.status?.[id] !== MODE_CONFIRMED,
  );
  if (unverified.length) {
    const names = unverified.map(sortModeLabel).join(' and ');
    const message =
      `${names} ${unverified.length === 1 ? 'is' : 'are'} using an unverified sort parameter, ` +
      'so those positions may really be Relevance results. Run Recalibrate in settings.';
    appendLog(scan, 'warn', message);
    addWarning(scan, message);
  } else if (calibration.stale) {
    addWarning(scan, 'Sort calibration is over 30 days old; consider recalibrating.');
  }

  await saveScan(scan);
  runLoop();
  return { ok: true };
}

async function pauseScan() {
  await patchScan((scan) => {
    if (scan.status === SCAN_STATUS.RUNNING) {
      scan.status = SCAN_STATUS.PAUSED;
      appendLog(scan, 'info', 'Paused. Press Resume to carry on from this page.');
    }
    return scan;
  });
  return { ok: true };
}

async function resumeScan() {
  const scan = await loadScan();
  if (!scan) return { ok: false, error: 'There is no scan to resume.' };
  if (scan.status === SCAN_STATUS.RUNNING) return { ok: true };
  if (scan.status === SCAN_STATUS.DONE || scan.status === SCAN_STATUS.ERROR) {
    return { ok: false, error: 'That scan already finished — start a new one.' };
  }

  // The original tab may be gone by the time the user resumes.
  let tabId = scan.tabId;
  try {
    await chrome.tabs.get(tabId);
  } catch {
    tabId = await resolveTargetTab();
  }

  await patchScan((s) => {
    s.status = SCAN_STATUS.RUNNING;
    s.tabId = tabId;
    appendLog(
      s,
      'info',
      `Resuming at ${sortModeLabel(s.sortModes[s.cursor.sortIndex])} page ${s.cursor.page}.`,
    );
    return s;
  });
  runLoop();
  return { ok: true };
}

export const HIGHLIGHT_KEY = 'pendingHighlight';
const HIGHLIGHT_TTL_MS = 2 * 60 * 1000;

/**
 * Open the page a finding came from and outline the gig on it.
 *
 * This is the answer to "are these numbers real?" — instead of asking the user to
 * trust a position, show them the gig sitting at it.
 */
async function highlightResult(payload) {
  const scan = await loadScan();
  if (scan && scan.status === SCAN_STATUS.RUNNING) {
    return { ok: false, error: 'Pause the scan first — it is driving the Fiverr tab.' };
  }

  const gigKey = String(payload.gigKey || '').trim();
  const keyword = String(payload.keyword || '').trim();
  const page = Math.max(parseInt(payload.page, 10) || 1, 1);
  const sortMode = SORT_MODE_IDS.includes(payload.sortMode) ? payload.sortMode : 'relevance';
  if (!gigKey || !keyword) return { ok: false, error: 'That result is missing its page details.' };

  const calibration = await loadCalibration();
  const url = buildSearchUrl(keyword, page, sortMode, calibration);
  const tabId = await resolveTargetTab();

  // The content script picks this up on load; the explicit message below covers
  // the case where it was already running on that URL.
  await chrome.storage.local.set({
    [HIGHLIGHT_KEY]: {
      gigKey,
      label: payload.label || null,
      expiresAt: Date.now() + HIGHLIGHT_TTL_MS,
    },
  });

  await navigateAndWait(tabId, url);
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await sendToContent(tabId, { type: 'HIGHLIGHT' }).catch(() => {});
  return { ok: true };
}

/**
 * Dump what the content script can actually see on a search page. Exists because
 * diagnosing the last round of extraction bugs took three rounds of hand-written
 * console snippets — this makes that self-serve.
 */
async function runDiagnostics(payload) {
  const tabId = await resolveTargetTab();
  const keyword = String(payload.keyword || '').trim() || CALIBRATION_KEYWORD;

  let tab = await chrome.tabs.get(tabId);
  if (!/\/search\/gigs/.test(tab.url || '')) {
    tab = await navigateAndWait(
      tabId,
      buildSearchUrl(keyword, 1, 'relevance', await loadCalibration()),
    );
  }

  const report = await sendToContent(tabId, { type: 'DIAGNOSE', modes: modePatterns() });
  if (!report?.ok) return { ok: false, error: report?.error || 'Could not read the page.' };

  // Run the real classifier over the real cards, then drop the bulky raw list so
  // the copyable report stays readable.
  const { organic, excluded, contiguous } = classifyCards(report.cards || [], report.url);
  const { cards, ...rest } = report;
  return {
    ok: true,
    report: {
      ...rest,
      classified: {
        organic: organic.length,
        excluded,
        contiguous,
        firstPositions: organic.slice(0, 3).map((c) => `${c.index + 1}. ${c.username}/${c.slug}`),
      },
      extensionVersion: chrome.runtime.getManifest().version,
    },
  };
}

async function getState() {
  const [scan, entitlement, calibration, history] = await Promise.all([
    loadScan(),
    getEntitlement(),
    loadCalibration(),
    listHistory(),
  ]);
  const calibrationState =
    (await chrome.storage.local.get(CALIBRATION_STATE_KEY))[CALIBRATION_STATE_KEY] || null;
  return {
    ok: true,
    scan,
    entitlement: { ...entitlement, checksRemaining: entitlement.unlimited ? null : entitlement.checksRemaining },
    calibration,
    calibrationState,
    history,
    sortModes: SORT_MODES.map((m) => ({ id: m.id, label: m.label })),
  };
}

const handlers = {
  GET_STATE: getState,
  START_SCAN: (payload) => startScan(payload),
  PAUSE_SCAN: pauseScan,
  RESUME_SCAN: resumeScan,
  RESET_SCAN: async () => {
    await clearScan();
    return { ok: true };
  },
  RUN_CALIBRATION: async () => {
    try {
      const record = await runCalibration();
      return { ok: true, calibration: record };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  },
  CLEAR_CALIBRATION: async () => {
    await clearCalibration();
    await chrome.storage.local.remove(CALIBRATION_STATE_KEY);
    return { ok: true };
  },
  CLEAR_HISTORY: async () => {
    await clearHistory();
    return { ok: true };
  },
  HIGHLIGHT_RESULT: (payload) => highlightResult(payload),
  RUN_DIAGNOSTICS: (payload) => runDiagnostics(payload),
  SET_PLAN: async (payload) => ({ ok: true, entitlement: await setPlan(payload.plan) }),
  RESET_CHECKS: async () => ({ ok: true, entitlement: await resetChecks() }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the panel talks to us; content-script replies come back through sendMessage.
  if (!message || typeof message.type !== 'string') return false;
  const handler = handlers[message.type];
  if (!handler) return false;

  handler(message.payload || {}).then(sendResponse, (error) =>
    sendResponse({ ok: false, error: String(error.message || error) }),
  );
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    /* setPanelBehavior already handles the common case */
  }
});
