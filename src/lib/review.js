/**
 * Review prompt scheduling.
 *
 * Deliberately *not* triggered by running out of free checks. That moment is a
 * paywall — the user has just been told to pay or wait, which is the worst
 * possible time to ask how much they like the product. Prompting there
 * systematically harvests one-star reviews from people who were about to have a
 * perfectly good day.
 *
 * Instead it waits for evidence the tool actually worked: a few completed scans.
 * Someone who has run three successful scans has got value out of it, and that is
 * when asking is both fair and likely to go well.
 *
 * The pure functions here carry all the scheduling rules so they can be tested
 * without a browser.
 */

export const REVIEW_KEY = 'reviewPrompt';

/** Completed scans before asking. Low enough to catch people while engaged. */
export const SCANS_BEFORE_PROMPT = 3;
export const SNOOZE_DAYS = 7;
/** After this many "not now"s, stop asking. A third ask is nagging. */
export const MAX_SNOOZES = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultReviewState() {
  return { scansCompleted: 0, status: 'pending', snoozeUntil: null, snoozes: 0 };
}

export function normalizeReviewState(stored) {
  return { ...defaultReviewState(), ...(stored || {}) };
}

/**
 * @param {object} state Stored review state.
 * @param {{scanRunning?: boolean, now?: number}} context
 */
export function shouldShowReviewPrompt(state, { scanRunning = false, now = Date.now() } = {}) {
  const record = normalizeReviewState(state);
  if (record.status !== 'pending') return false;
  // Never interrupt a run in progress; the panel is busy showing live results.
  if (scanRunning) return false;
  if (record.scansCompleted < SCANS_BEFORE_PROMPT) return false;
  if (record.snoozeUntil && now < record.snoozeUntil) return false;
  return true;
}

/** Counted once per completed scan, wherever the scan finished successfully. */
export function recordCompletedScan(state) {
  const record = normalizeReviewState(state);
  return { ...record, scansCompleted: record.scansCompleted + 1 };
}

/**
 * @param {'rated'|'feedback'|'later'|'dismiss'} action
 */
export function applyReviewAction(state, action, now = Date.now()) {
  const record = normalizeReviewState(state);

  switch (action) {
    // Both "rated" and "feedback" end the cycle: the user has told us something,
    // and asking again after they responded is the fastest way to be uninstalled.
    case 'rated':
    case 'feedback':
      return { ...record, status: 'done', respondedAt: now };

    case 'later': {
      const snoozes = record.snoozes + 1;
      return {
        ...record,
        snoozes,
        status: snoozes >= MAX_SNOOZES ? 'dismissed' : 'pending',
        snoozeUntil: now + SNOOZE_DAYS * DAY_MS,
      };
    }

    case 'dismiss':
      return { ...record, status: 'dismissed', respondedAt: now };

    default:
      return record;
  }
}

// --- storage -----------------------------------------------------------------

export async function loadReviewState() {
  return normalizeReviewState((await chrome.storage.local.get(REVIEW_KEY))[REVIEW_KEY]);
}

export async function saveReviewState(state) {
  await chrome.storage.local.set({ [REVIEW_KEY]: state });
  return state;
}

/** Chrome Web Store review page for whichever build this is. */
export function reviewUrl() {
  return `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
}
