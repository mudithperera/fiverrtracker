/**
 * Panel UI. Pure renderer: it sends commands to the background worker and redraws
 * from chrome.storage. It deliberately holds no scan state of its own, so closing
 * and reopening the panel mid-scan loses nothing.
 *
 * Written to work unchanged as a side panel or inside an injected overlay iframe —
 * it only ever talks over chrome.runtime.
 */

import { summarizeBySortMode } from './lib/extract.js';
import { MODE_CONFIRMED, SORT_MODE_IDS, sortModeLabel } from './lib/sortmodes.js';
import { describeExclusions, injectedExclusions } from './lib/cards.js';
import { SCAN_STATUS } from './lib/scan-state.js';

const FORM_PREFS_KEY = 'formPrefs';

const $ = (id) => document.getElementById(id);

const els = {
  tabs: document.querySelectorAll('.tab'),
  viewChecker: $('view-checker'),
  viewHistory: $('view-history'),
  menu: $('menu'),
  menuToggle: $('menu-toggle'),
  menuClose: $('menu-close'),
  menuScrim: $('menu-scrim'),
  menuTabs: document.querySelectorAll('.menu-tab'),
  menuSections: document.querySelectorAll('.menu-section'),
  accountAvatar: $('account-avatar'),
  accountName: $('account-name'),
  intervalToggle: $('interval-toggle'),
  planList: $('plan-list'),
  recalibrate: $('recalibrate'),
  calibrationStatus: $('calibration-status'),
  diagnose: $('diagnose'),
  diagnostics: $('diagnostics'),
  signIn: $('sign-in'),
  signOut: $('sign-out'),
  accountStatus: $('account-status'),
  manageBilling: $('manage-billing'),
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
let planCatalogue = null;
let billingInterval = 'month';

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
    els.quota.textContent = `${entitlement.planLabel} — unlimited checks`;
    els.upgrade.classList.add('hidden');
    return;
  }
  const left = entitlement.checksRemaining ?? 0;
  // Quotas are per day and reset at midnight UTC, matching the server's counter.
  els.quota.textContent = entitlement.signedIn
    ? `${left} of ${entitlement.limit} checks left today`
    : `${left} of ${entitlement.limit} free checks — sign in for more`;
  els.upgrade.classList.remove('hidden');
}

function renderAccount(state) {
  const entitlement = state.entitlement || {};
  const signedIn = Boolean(state.signedIn);

  els.signIn.classList.toggle('hidden', signedIn);
  els.signOut.classList.toggle('hidden', !signedIn);
  els.manageBilling.classList.toggle('hidden', !entitlement.subscription);

  if (!signedIn) {
    els.accountName.textContent = 'Not signed in';
    els.accountStatus.textContent = `${entitlement.checksRemaining ?? 0} free checks left today`;
    els.accountAvatar.textContent = '';
    els.accountAvatar.style.backgroundImage = '';
    return;
  }

  const account = state.account || {};
  els.accountName.textContent = account.name || account.email || 'Signed in';

  if (account.picture) {
    els.accountAvatar.style.backgroundImage = `url("${account.picture}")`;
    els.accountAvatar.textContent = '';
  } else {
    els.accountAvatar.style.backgroundImage = '';
    els.accountAvatar.textContent = (account.email || '?').charAt(0).toUpperCase();
  }

  const parts = [entitlement.planLabel].filter(Boolean);
  if (entitlement.stale) parts.push('offline — last known plan');
  else if (entitlement.subscription?.cancelAtPeriodEnd) parts.push('ends at period end');
  if (account.email && account.name) parts.unshift(account.email);
  els.accountStatus.textContent = parts.join(' · ');
}

// --- plans -------------------------------------------------------------------

function planCard(plan, currentPlanId) {
  const price = plan.intervals?.[billingInterval];
  const isCurrent = plan.id === currentPlanId;

  const card = document.createElement('article');
  card.className = `plan-card${isCurrent ? ' is-current' : ''}`;

  const head = document.createElement('div');
  head.className = 'plan-head';
  const name = document.createElement('strong');
  name.textContent = plan.label;
  head.append(name);

  if (isCurrent) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'current';
    head.append(badge);
  } else if (price?.note) {
    const badge = document.createElement('span');
    badge.className = 'badge warn';
    badge.textContent = price.note;
    head.append(badge);
  }

  const cost = document.createElement('div');
  cost.className = 'plan-price';
  // "$0" rather than "Free", which would just repeat the plan name above it.
  cost.textContent = price ? `${price.display}${price.suffix}` : '$0';

  const blurb = document.createElement('p');
  blurb.className = 'plan-blurb';
  blurb.textContent = plan.blurb;

  const features = document.createElement('ul');
  features.className = 'plan-features';
  for (const line of plan.features || []) {
    const li = document.createElement('li');
    li.textContent = line;
    features.append(li);
  }

  card.append(head, cost, blurb, features);

  // The free plan has nothing to buy, and the current plan is changed through
  // Stripe's portal rather than a second checkout.
  if (plan.purchasable && !isCurrent && price) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary btn-block';
    button.textContent = `Choose ${plan.label}`;
    button.addEventListener('click', () => checkout(plan.id, button));
    card.append(button);
  }

  return card;
}

function renderPlans() {
  els.planList.replaceChildren();

  if (!planCatalogue) {
    const loading = document.createElement('p');
    loading.className = 'empty';
    loading.textContent = 'Loading plans…';
    els.planList.append(loading);
    return;
  }

  const currentPlanId = lastState?.entitlement?.plan || 'free';
  for (const plan of planCatalogue) {
    els.planList.append(planCard(plan, currentPlanId));
  }
}

async function loadPlans() {
  if (planCatalogue) return;
  const response = await send('GET_PLANS');
  if (response?.ok) {
    planCatalogue = response.plans;
  } else {
    planCatalogue = null;
    els.planList.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'empty';
    failed.textContent = response?.error || 'Could not load plans.';
    els.planList.append(failed);
    return;
  }
  renderPlans();
}

async function checkout(plan, button) {
  showError('');
  if (!lastState?.signedIn) {
    showError('Sign in first — a subscription needs an account to attach to.');
    return;
  }
  button.disabled = true;
  const response = await send('OPEN_CHECKOUT', { plan, interval: billingInterval });
  button.disabled = false;
  if (!response?.ok) showError(response?.error || 'Could not start checkout.');
}

// --- menu --------------------------------------------------------------------

function openMenu(section) {
  els.menu.classList.remove('hidden');
  els.menuToggle.setAttribute('aria-expanded', 'true');
  if (section) selectMenuSection(section);
  if (section === 'plans') loadPlans();
}

function closeMenu() {
  els.menu.classList.add('hidden');
  els.menuToggle.setAttribute('aria-expanded', 'false');
}

function selectMenuSection(section) {
  els.menuTabs.forEach((tab) => {
    const active = tab.dataset.section === section;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  els.menuSections.forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `menu-${section}`);
  });
  if (section === 'plans') loadPlans();
}

function renderWarnings(state) {
  const messages = [];
  // Nothing pre-emptive about calibration here: each scanned page is checked
  // against Fiverr's own sort control, so a broken sort raises a real warning
  // below rather than a standing banner that is usually wrong.
  if (state.calibration?.stale) {
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Findings recorded before gigKey existed still have a URL we can read it from. */
function gigKeyOf(finding) {
  if (finding.gigKey) return finding.gigKey;
  try {
    const parts = new URL(finding.gigUrl).pathname.split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  } catch {
    return '';
  }
}

/**
 * Open the search page a finding came from and outline the gig on it, so a
 * reported position can be checked against the real page rather than trusted.
 */
async function showOnFiverr(scan, finding, button) {
  showError('');
  button.disabled = true;
  const response = await send('HIGHLIGHT_RESULT', {
    gigKey: gigKeyOf(finding),
    keyword: scan.keyword,
    sortMode: finding.sortMode,
    page: finding.page,
    label: `#${finding.absolutePosition} · position ${finding.positionOnPage} on page ${finding.page}`,
  });
  button.disabled = false;
  if (!response?.ok) showError(response?.error || 'Could not open that result.');
}

function headlineFor(entry) {
  if (entry.found) {
    const best = entry.best;
    return `page ${best.page} · position ${best.positionOnPage} · #${best.absolutePosition} overall`;
  }
  if (entry.pagesScanned === 0) return 'not scanned yet';
  if (entry.exhausted) return `not found — results ran out after ${plural(entry.pagesScanned, 'page')}`;
  return `not found in ${plural(entry.pagesScanned, 'page')}`;
}

function renderSummary(scan) {
  els.summary.replaceChildren();
  if (!scan) return;

  const summary = summarizeBySortMode(scan);
  for (const modeId of scan.sortModes) {
    const entry = summary[modeId];
    const block = document.createElement('section');
    const mismatched = scan.progress?.[modeId]?.sortMismatch ? ' mismatched' : '';
    block.className = `mode-block ${entry.found ? 'found' : 'missing'}${mismatched}`;

    const head = document.createElement('div');
    head.className = 'mode-head';
    const name = document.createElement('span');
    name.className = 'mode';
    name.textContent = sortModeLabel(modeId);
    head.append(name);

    // Fiverr told us it was sorting by something else — the strongest possible
    // signal that these positions are not what the mode name claims.
    const progress = scan.progress?.[modeId];
    const proven = progress?.sortVerified || scan.calibrationStatus?.[modeId] === MODE_CONFIRMED;
    if (progress?.sortMismatch) {
      const badge = document.createElement('span');
      badge.className = 'badge bad';
      badge.textContent = `actually ${sortModeLabel(progress.sortMismatch)}`;
      head.append(badge);
    } else if (modeId !== 'relevance' && progress?.pagesScanned > 0 && !proven) {
      // Scanned, but Fiverr's sort control was never readable to confirm it.
      const badge = document.createElement('span');
      badge.className = 'badge warn';
      badge.textContent = 'sort unconfirmed';
      head.append(badge);
    }

    const headline = document.createElement('div');
    headline.className = 'headline';
    headline.textContent = headlineFor(entry);

    block.append(head, headline);

    // A seller can rank more than once for the same keyword; each row opens the
    // page it was found on.
    if (entry.all.length) {
      const list = document.createElement('ul');
      list.className = 'gig-list';
      const ordered = [...entry.all].sort((a, b) => a.absolutePosition - b.absolutePosition);
      for (const finding of ordered) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'gig-row';
        button.title = 'Open this page on Fiverr and highlight the gig';

        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = `#${finding.absolutePosition}`;

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = finding.gigTitle || '(untitled gig)';

        button.append(pos, title);
        button.addEventListener('click', () => showOnFiverr(scan, finding, button));
        item.append(button);
        list.append(item);
      }
      block.append(list);
    }

    const excluded = describeExclusions(injectedExclusions(scan.progress?.[modeId]?.excluded));
    if (excluded) {
      const note = document.createElement('div');
      note.className = 'excluded-note';
      note.textContent = `Not counted as results: ${excluded}`;
      block.append(note);
    }

    els.summary.append(block);
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
    return;
  }

  // Per mode, because "calibrated" as a single flag hid the case that mattered:
  // a parameter that was read successfully but that Fiverr then ignores.
  const status = state.calibration?.status || {};
  const parts = SORT_MODE_IDS.filter((id) => id !== 'relevance').map((id) => {
    const ok = status[id] === MODE_CONFIRMED;
    return `${sortModeLabel(id)}: ${ok ? 'verified' : 'unverified'}`;
  });

  if (state.calibration?.source === 'calibrated' && state.calibration.capturedAt) {
    const when = new Date(state.calibration.capturedAt).toLocaleDateString();
    els.calibrationStatus.textContent = `Checked ${when} — ${parts.join(', ')}`;
  } else {
    els.calibrationStatus.textContent = `Never checked — ${parts.join(', ')}`;
  }
}

function renderDiagnostics(report) {
  if (!report) {
    els.diagnostics.classList.add('hidden');
    els.diagnostics.value = '';
    return;
  }
  els.diagnostics.value = JSON.stringify(report, null, 2);
  els.diagnostics.classList.remove('hidden');
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
  renderAccount(state);
  // Keep the "current" badge honest after a plan change lands.
  if (planCatalogue) renderPlans();
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

els.menuToggle.addEventListener('click', () => {
  if (els.menu.classList.contains('hidden')) openMenu();
  else closeMenu();
});

els.menuClose.addEventListener('click', closeMenu);
els.menuScrim.addEventListener('click', closeMenu);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.menu.classList.contains('hidden')) closeMenu();
});

els.menuTabs.forEach((tab) => {
  tab.addEventListener('click', () => selectMenuSection(tab.dataset.section));
});

els.intervalToggle.addEventListener('click', (event) => {
  const option = event.target.closest('.interval-option');
  if (!option) return;
  billingInterval = option.dataset.interval;
  els.intervalToggle.querySelectorAll('.interval-option').forEach((el) => {
    el.classList.toggle('is-active', el === option);
  });
  renderPlans();
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

els.diagnose.addEventListener('click', async () => {
  showError('');
  els.diagnose.disabled = true;
  const previous = els.diagnose.textContent;
  els.diagnose.textContent = 'Reading page…';
  const response = await send('RUN_DIAGNOSTICS', { keyword: els.keyword.value });
  els.diagnose.disabled = false;
  els.diagnose.textContent = previous;
  if (!response?.ok) {
    showError(response?.error || 'Could not read the Fiverr page.');
    return;
  }
  renderDiagnostics(response.report);
  els.diagnostics.select();
});

els.signIn.addEventListener('click', async () => {
  showError('');
  els.signIn.disabled = true;
  const response = await send('SIGN_IN');
  els.signIn.disabled = false;
  if (!response?.ok) showError(response?.error || 'Sign-in failed.');
  refresh();
});

els.signOut.addEventListener('click', async () => {
  await send('SIGN_OUT');
  refresh();
});

els.manageBilling.addEventListener('click', async () => {
  showError('');
  const response = await send('OPEN_BILLING_PORTAL');
  if (!response?.ok) showError(response?.error || 'Could not open the billing portal.');
});

els.resetChecks.addEventListener('click', async () => {
  await send('RESET_CHECKS');
  refresh();
});

els.upgrade.addEventListener('click', () => openMenu('plans'));

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
