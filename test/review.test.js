import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SNOOZES,
  SCANS_BEFORE_PROMPT,
  SNOOZE_DAYS,
  applyReviewAction,
  defaultReviewState,
  recordCompletedScan,
  shouldShowReviewPrompt,
} from '../src/lib/review.js';

const NOW = Date.UTC(2026, 6, 27);
const DAY = 24 * 60 * 60 * 1000;

const withScans = (n, extra = {}) => ({ ...defaultReviewState(), scansCompleted: n, ...extra });

test('stays quiet until the tool has actually worked a few times', () => {
  for (let scans = 0; scans < SCANS_BEFORE_PROMPT; scans += 1) {
    assert.equal(shouldShowReviewPrompt(withScans(scans), { now: NOW }), false, `${scans} scans`);
  }
  assert.equal(shouldShowReviewPrompt(withScans(SCANS_BEFORE_PROMPT), { now: NOW }), true);
});

test('never interrupts a running scan', () => {
  const ready = withScans(SCANS_BEFORE_PROMPT + 5);
  assert.equal(shouldShowReviewPrompt(ready, { now: NOW, scanRunning: true }), false);
  assert.equal(shouldShowReviewPrompt(ready, { now: NOW, scanRunning: false }), true);
});

test('recordCompletedScan counts up from nothing', () => {
  assert.equal(recordCompletedScan(null).scansCompleted, 1);
  assert.equal(recordCompletedScan(withScans(4)).scansCompleted, 5);
});

test('"not now" hides the prompt for a week, then asks once more', () => {
  const ready = withScans(SCANS_BEFORE_PROMPT + 1);
  const snoozed = applyReviewAction(ready, 'later', NOW);

  assert.equal(snoozed.status, 'pending', 'one snooze is not a refusal');
  assert.equal(shouldShowReviewPrompt(snoozed, { now: NOW + DAY }), false);
  assert.equal(shouldShowReviewPrompt(snoozed, { now: NOW + (SNOOZE_DAYS + 1) * DAY }), true);
});

test('a second "not now" ends it — a third ask is nagging', () => {
  let state = withScans(SCANS_BEFORE_PROMPT + 1);
  for (let i = 0; i < MAX_SNOOZES; i += 1) state = applyReviewAction(state, 'later', NOW);

  assert.equal(state.snoozes, MAX_SNOOZES);
  assert.equal(state.status, 'dismissed');
  assert.equal(shouldShowReviewPrompt(state, { now: NOW + 365 * DAY }), false, 'never again');
});

test('responding either way ends the cycle', () => {
  // Someone who left a review and someone who sent feedback have both told us
  // something; asking again is the fastest route to an uninstall.
  for (const action of ['rated', 'feedback']) {
    const state = applyReviewAction(withScans(99), action, NOW);
    assert.equal(state.status, 'done', action);
    assert.equal(shouldShowReviewPrompt(state, { now: NOW + 365 * DAY }), false, action);
  }
});

test('dismissing is permanent', () => {
  const state = applyReviewAction(withScans(99), 'dismiss', NOW);
  assert.equal(state.status, 'dismissed');
  assert.equal(shouldShowReviewPrompt(state, { now: NOW + 365 * DAY }), false);
});

test('an unknown action changes nothing', () => {
  const before = withScans(9, { snoozes: 1 });
  assert.deepEqual(applyReviewAction(before, 'nonsense', NOW), before);
});

test('scan counting survives a missing or partial stored record', () => {
  assert.equal(shouldShowReviewPrompt(undefined, { now: NOW }), false);
  assert.equal(shouldShowReviewPrompt({ scansCompleted: 99 }, { now: NOW }), true, 'legacy record');
});
