/**
 * Panel UI. Pure renderer: it sends commands to the background worker and redraws
 * from chrome.storage. It deliberately holds no scan state of its own, so closing
 * and reopening the panel mid-scan loses nothing.
 *
 * Written to work unchanged as a side panel or inside an injected overlay iframe —
 * it only ever talks over chrome.runtime.
 */

import { summarizeBySortMode } from './lib/extract.js';
import { sortModeLabel } from './lib/sortmodes.js';
import { SCAN_STATUS } from './lib/scan-state.js';

const FORM_PREFS_KEY = 'formPrefs';

const $ = (id) => document.getElementById(id);

const els = {
  tabs: document.querySelectorAll('.tab'),
  viewChecker: $('view-checker'),
  viewHistory: $('view-history'),
  settingsToggle: $('settings-toggle'),
  settingsPanel: $('settings-panel'),
  recalibrate: $('recalibrate'),
  calibrationStatus: $('calibration-status'),
  togglePlan: $('toggle-plan'),
  resetChecks: $('reset-checks'),
  upgrade: $('upgrade'),
  quota: $('quota'),
  warnings: $('warnings'),
  keyword: $('keyword'),
  username: $('username'),
  usernameHint: $('username-hint'),
  sortmodeList: $('sortmode-list'),
  maxPages: $('max-pages'),
  delay: $('delay'),
  start: $('start'),
  stop: $('stop'),
  resume: $('resume'),
  error: $('error'),
  statusChip: $('status-chip'),
  progressText: $('progress-text'),
  summary: $('summary'),
  log: $('log'),
  historyFilter: $('history-filter'),
  historyList: $('history-list'),
  clearHistory: $('clear-history'),
};

let lastState = null;
let historyFilter = '';

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function showError(message) {
  if (!message) {
    els.error.classList.add('hidden');
    els.error.textContent = '';
    return;
  }
  els.error.textContent = message;
  els.error.classList.remove('hidden');
}

// --- form persistence ---------------------------------------------------------

async function loadPrefs() {
  const prefs = (await chrome.storage.local.get(FORM_PREFS_KEY))[FORM_PREFS_KEY] || {};
  els.keyword.value = prefs.keyword ?? '';
  els.username.value = prefs.username ?? '';
  els.maxPages.value = prefs.maxPages ?? 10;
  els.delay.value = prefs.delaySeconds ?? 0.8;
  return prefs;
}

function currentSortModes() {
  return Array.from(els.sortmodeList.querySelectorAll('input:checked')).map((i) => i.value);
}

async function savePrefs() {
  await chrome.storage.local.set({
    [FORM_PREFS_KEY]: {
      keyword: els.keyword.value,
      username: els.username.value,
      maxPages: els.maxPages.value,
      delaySeconds: els.delay.value,
      sortModes: currentSortModes(),
    },
  });
}

// --- rendering ----------------------------------------------------------------

function renderSortModes(state, prefs) {
  if (els.sortmodeList.childElementCount) return; // built once
  const enabled = new Set(prefs.sortModes ?? state.sortModes.map((m) => m.id));
  for (const mode of state.sortModes) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = mode.id;
    input.checked = enabled.has(mode.id);
    label.classList.toggle('checked', input.checked);
    input.addEventListener('change', () => {
      label.classList.toggle('checked', input.checked);
      savePrefs();
    });
    label.append(input, document.createTextNode(mode.label));
    els.sortmodeList.append(label);
  }
}

function renderQuota(entitlement) {
  if (entitlement.unlimited) {
    els.quota.textContent = 'Unlimited plan — no check limit';
    els.upgrade.classList.add('hidden');
    return;
  }
  const left = entitlement.checksRemaining ?? 0;
  els.quota.textContent = `${left} of ${entitlement.limit} free ranking checks left`;
  els.upgrade.classList.remove('hidden');
}

function renderWarnings(state) {
  const messages = [];
  if (state.calibration?.source === 'fallback') {
    messages.push(
      'Sort modes have not been calibrated against Fiverr yet. Best Selling and New Arrivals may not be accurate — open settings and run Recalibrate.',
    );
  } else if (state.calibration?.stale) {
    messages.push('Sort calibration is more than 30 days old. Consider recalibrating.');
  }
  for (const warning of state.scan?.warnings || []) messages.push(warning);

  if (!messages.length) {
    els.warnings.classList.add('hidden');
    return;
  }
  els.warnings.textContent = messages.join(' ');
  els.warnings.classList.remove('hidden');
}

function positionText(finding) {
  return `page ${finding.page}, position ${finding.positionOnPage} (#${finding.absolutePosition} overall)`;
}

function renderSummary(scan) {
  els.summary.replaceChildren();
  if (!scan) return;

  const summary = summarizeBySortMode(scan);
  for (const modeId of scan.sortModes) {
    const entry = summary[modeId];
    const row = document.createElement('div');
    row.className = `summary-row ${entry.found ? 'found' : 'missing'}`;

    const mode = document.createElement('span');
    mode.className = 'mode';
    mode.textContent = sortModeLabel(modeId);

    const value = document.createElement('span');
    value.className = 'value';
    if (entry.found) {
      value.textContent = positionText(entry.best);
    } else if (entry.pagesScanned === 0) {
      value.textContent = 'not scanned yet';
    } else if (entry.exhausted) {
      value.textContent = `not found (${entry.pagesScanned} page${entry.pagesScanned === 1 ? '' : 's'}, results ran out)`;
    } else {
      value.textContent = `not found in ${entry.pagesScanned} page${entry.pagesScanned === 1 ? '' : 's'}`;
    }

    row.append(mode, value);
    els.summary.append(row);

    // A seller can rank more than once for the same keyword.
    if (entry.all.length > 1) {
      const extra = document.createElement('div');
      extra.className = 'summary-extra';
      extra.textContent = `${entry.all.length} gigs from this seller: ${entry.all
        .map((f) => `#${f.absolutePosition}`)
        .join(', ')}`;
      els.summary.append(extra);
    }
  }
}

const STATUS_LABEL = {
  [SCAN_STATUS.RUNNING]: 'SCANNING',
  [SCAN_STATUS.PAUSED]: 'PAUSED',
  [SCAN_STATUS.BLOCKED]: 'NEEDS YOU',
  [SCAN_STATUS.DONE]: 'DONE',
  [SCAN_STATUS.ERROR]: 'ERROR',
};

function renderScan(scan) {
  const status = scan?.status || 'idle';
  els.statusChip.dataset.status = status;
  els.statusChip.textContent = STATUS_LABEL[status] || 'IDLE';

  if (scan && scan.status === SCAN_STATUS.RUNNING) {
    const modeId = scan.sortModes[scan.cursor.sortIndex];
    els.progressText.textContent = modeId
      ? `${sortModeLabel(modeId)} · page ${scan.cursor.page} of ${scan.maxPages} · sort ${scan.cursor.sortIndex + 1}/${scan.sortModes.length}`
      : '';
  } else if (scan && scan.status === SCAN_STATUS.BLOCKED) {
    els.progressText.textContent = 'Solve the Fiverr check in the tab, then press Resume.';
  } else {
    els.progressText.textContent = '';
  }

  renderSummary(scan);

  els.log.replaceChildren();
  for (const entry of (scan?.log || []).slice(-60)) {
    const li = document.createElement('li');
    li.dataset.level = entry.level;
    li.textContent = entry.message;
    els.log.append(li);
  }
  els.log.scrollTop = els.log.scrollHeight;

  const running = status === SCAN_STATUS.RUNNING;
  const resumable = status === SCAN_STATUS.PAUSED || status === SCAN_STATUS.BLOCKED;
  els.start.disabled = running;
  els.stop.disabled = !running;
  els.resume.disabled = !resumable;
}

function renderCalibration(state) {
  const calState = state.calibrationState;
  if (calState?.running) {
    els.calibrationStatus.textContent = calState.step || 'Calibrating…';
    els.recalibrate.disabled = true;
    return;
  }
  els.recalibrate.disabled = false;
  if (calState?.error) {
    els.calibrationStatus.textContent = `Failed: ${calState.error}`;
  } else if (state.calibration?.source === 'calibrated') {
    const when = new Date(state.calibration.capturedAt).toLocaleDateString();
    const partial = calState?.partial?.length
      ? ` (${calState.partial.map(sortModeLabel).join(', ')} fell back to defaults)`
      : '';
    els.calibrationStatus.textContent = `Calibrated ${when}${partial}`;
  } else {
    els.calibrationStatus.textContent = 'Not calibrated yet';
  }
}

function renderHistory(history) {
  els.historyList.replaceChildren();
  const filter = historyFilter.trim().toLowerCase();
  const entries = history.filter(
    (e) =>
      !filter ||
      e.keyword.toLowerCase().includes(filter) ||
      e.username.toLowerCase().includes(filter),
  );

  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = history.length
      ? 'No history entries match that filter.'
      : 'No completed scans yet. Run a ranking check and it will show up here.';
    els.historyList.append(empty);
    return;
  }

  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'history-entry';

    const head = document.createElement('div');
    head.className = 'history-head';
    const title = document.createElement('strong');
    title.textContent = `“${entry.keyword}” · @${entry.username}`;
    const when = document.createElement('span');
    when.className = 'muted';
    when.textContent = new Date(entry.finishedAt).toLocaleString();
    head.append(title, when);

    const rows = document.createElement('div');
    rows.className = 'history-rows';

    // Best row per sort mode, so a seller with several gigs gets one line each.
    for (const modeId of entry.sortModes) {
      const modeRows = entry.rows.filter((r) => r.sortMode === modeId);
      const found = modeRows.filter((r) => r.found);
      const best = found.length
        ? found.reduce((a, b) => (a.absolutePosition <= b.absolutePosition ? a : b))
        : null;

      const row = document.createElement('div');
      row.className = `history-row ${best ? 'found' : 'missing'}`;
      const label = document.createElement('span');
      label.textContent = sortModeLabel(modeId);
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = best
        ? `page ${best.page} · #${best.absolutePosition}`
        : 'not found';
      row.append(label, pos);
      rows.append(row);
    }

    card.append(head, rows);
    els.historyList.append(card);
  }
}

async function refresh() {
  const state = await send('GET_STATE');
  if (!state?.ok) return;
  lastState = state;

  const prefs = (await chrome.storage.local.get(FORM_PREFS_KEY))[FORM_PREFS_KEY] || {};
  renderSortModes(state, prefs);
  renderQuota(state.entitlement);
  renderWarnings(state);
  renderScan(state.scan);
  renderCalibration(state);
  renderHistory(state.history);

  els.togglePlan.textContent =
    state.entitlement.plan === 'unlimited' ? 'Switch back to Free plan' : 'Simulate Unlimited plan';
}

// --- events -------------------------------------------------------------------

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    els.tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    const showHistory = tab.dataset.view === 'history';
    els.viewChecker.classList.toggle('hidden', showHistory);
    els.viewHistory.classList.toggle('hidden', !showHistory);
  });
});

els.settingsToggle.addEventListener('click', () => {
  els.settingsPanel.classList.toggle('hidden');
});

els.start.addEventListener('click', async () => {
  showError('');
  await savePrefs();
  const response = await send('START_SCAN', {
    keyword: els.keyword.value,
    rawUsername: els.username.value,
    maxPages: els.maxPages.value,
    delaySeconds: els.delay.value,
    sortModes: currentSortModes(),
  });
  if (!response?.ok) showError(response?.error || 'Could not start the scan.');
  refresh();
});

els.stop.addEventListener('click', async () => {
  await send('PAUSE_SCAN');
  refresh();
});

els.resume.addEventListener('click', async () => {
  showError('');
  const response = await send('RESUME_SCAN');
  if (!response?.ok) showError(response?.error || 'Could not resume.');
  refresh();
});

els.recalibrate.addEventListener('click', async () => {
  els.calibrationStatus.textContent = 'Calibrating…';
  els.recalibrate.disabled = true;
  const response = await send('RUN_CALIBRATION');
  if (!response?.ok) els.calibrationStatus.textContent = `Failed: ${response?.error || 'unknown error'}`;
  refresh();
});

els.togglePlan.addEventListener('click', async () => {
  const next = lastState?.entitlement?.plan === 'unlimited' ? 'free' : 'unlimited';
  await send('SET_PLAN', { plan: next });
  refresh();
});

els.resetChecks.addEventListener('click', async () => {
  await send('RESET_CHECKS');
  refresh();
});

els.upgrade.addEventListener('click', () => {
  showError('Billing is not wired up yet — this is a placeholder for the paid plan.');
});

els.clearHistory.addEventListener('click', async () => {
  await send('CLEAR_HISTORY');
  refresh();
});

els.historyFilter.addEventListener('input', () => {
  historyFilter = els.historyFilter.value;
  if (lastState) renderHistory(lastState.history);
});

els.username.addEventListener('input', () => {
  const value = els.username.value.trim();
  // Reassure the user that "@name" and a pasted profile URL both work.
  els.usernameHint.textContent = value
    ? `Will search for: @${value.replace(/^@+/, '').split('/').filter(Boolean).pop()?.toLowerCase() || ''}`
    : '';
  savePrefs();
});

for (const input of [els.keyword, els.maxPages, els.delay]) {
  input.addEventListener('change', savePrefs);
}

// The background writes scan progress to storage; redraw whenever it changes.
let refreshQueued = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refresh();
  }, 120);
});

loadPrefs().then(refresh);
