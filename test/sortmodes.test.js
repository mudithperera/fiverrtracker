import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SORT_MODE_IDS,
  buildSearchUrl,
  describeSortMismatch,
  diffSortParams,
  fallbackCalibration,
} from '../src/lib/sortmodes.js';
import { advanceCursor, createScan, scanProgress } from '../src/lib/scan-state.js';

test('buildSearchUrl omits the page parameter on page 1', () => {
  const url = new URL(buildSearchUrl('logo design', 1, 'relevance', fallbackCalibration()));
  assert.equal(url.searchParams.get('query'), 'logo design');
  assert.equal(url.searchParams.has('page'), false);
});

test('buildSearchUrl sets the page parameter beyond page 1', () => {
  const url = new URL(buildSearchUrl('logo design', 4, 'relevance', fallbackCalibration()));
  assert.equal(url.searchParams.get('page'), '4');
});

test('buildSearchUrl applies calibrated sort parameters', () => {
  const calibration = {
    source: 'calibrated',
    params: {
      relevance: {},
      best_selling: { sort_by: 'rating' },
      new_arrivals: { sort_by: 'recent' },
    },
  };
  const relevance = new URL(buildSearchUrl('logo', 1, 'relevance', calibration));
  const best = new URL(buildSearchUrl('logo', 1, 'best_selling', calibration));
  const fresh = new URL(buildSearchUrl('logo', 1, 'new_arrivals', calibration));

  assert.equal(relevance.searchParams.has('sort_by'), false, 'relevance is the default sort');
  assert.equal(best.searchParams.get('sort_by'), 'rating');
  assert.equal(fresh.searchParams.get('sort_by'), 'recent');
});

test('buildSearchUrl falls back when calibration is missing a mode', () => {
  // Defaults observed from Fiverr's own sort menu: filter=auto/rating/new.
  assert.equal(
    new URL(buildSearchUrl('logo', 1, 'best_selling', { params: {} })).searchParams.get('filter'),
    'rating',
  );
  assert.equal(
    new URL(buildSearchUrl('logo', 1, 'new_arrivals', { params: {} })).searchParams.get('filter'),
    'new',
  );
  assert.equal(
    new URL(buildSearchUrl('logo', 1, 'relevance', { params: {} })).searchParams.get('filter'),
    'auto',
  );
});

test('diffSortParams isolates the sort parameter and ignores noise', () => {
  const base = 'https://www.fiverr.com/search/gigs?query=logo&source=top-bar&page=1';
  const next =
    'https://www.fiverr.com/search/gigs?query=logo&source=top-bar&page=3&sort_by=best_selling&ref_ctx_id=abc';

  assert.deepEqual(diffSortParams(base, next), { sort_by: 'best_selling' });
});

test('diffSortParams returns nothing when only tracking params changed', () => {
  const base = 'https://www.fiverr.com/search/gigs?query=logo';
  const next = 'https://www.fiverr.com/search/gigs?query=logo&ref_ctx_id=xyz&pos=2';
  assert.deepEqual(diffSortParams(base, next), {});
});

test('fallbackCalibration covers every sort mode', () => {
  const calibration = fallbackCalibration();
  assert.equal(calibration.source, 'fallback');
  for (const id of SORT_MODE_IDS) {
    assert.ok(calibration.params[id], `missing fallback for ${id}`);
  }
});

// --- cursor ------------------------------------------------------------------

function newScan(overrides = {}) {
  return createScan({
    keyword: 'logo design',
    username: 'someone',
    rawUsername: '@someone',
    maxPages: 3,
    delayMs: 800,
    sortModes: ['relevance', 'best_selling', 'new_arrivals'],
    tabId: 1,
    ...overrides,
  });
}

test('advanceCursor walks pages then moves to the next sort mode', () => {
  const scan = newScan();
  assert.deepEqual(scan.cursor, { sortIndex: 0, page: 1 });

  advanceCursor(scan);
  assert.deepEqual(scan.cursor, { sortIndex: 0, page: 2 });

  advanceCursor(scan);
  assert.deepEqual(scan.cursor, { sortIndex: 0, page: 3 });

  advanceCursor(scan); // maxPages reached
  assert.deepEqual(scan.cursor, { sortIndex: 1, page: 1 });
});

test('advanceCursor skips the rest of a sort mode when results run out', () => {
  const scan = newScan();
  const keepGoing = advanceCursor(scan, { exhaustCurrentMode: true });

  assert.equal(keepGoing, true);
  assert.deepEqual(scan.cursor, { sortIndex: 1, page: 1 });
  assert.equal(scan.progress.relevance.exhausted, true, 'mode is marked exhausted for the summary');
});

test('advanceCursor reports completion after the last sort mode', () => {
  const scan = newScan({ sortModes: ['relevance'] });
  assert.equal(advanceCursor(scan, { exhaustCurrentMode: true }), false);
  assert.equal(scan.cursor.sortIndex, 1);
});

test('createScan seeds progress for every selected sort mode', () => {
  const scan = newScan();
  for (const id of scan.sortModes) {
    assert.deepEqual(scan.progress[id], {
      pagesScanned: 0,
      gigsSeen: 0,
      exhausted: false,
      excluded: {},
    });
  }
});

// --- describing a sort mismatch ----------------------------------------------

test('a mode sorted by something else says so in words, not just a colour', () => {
  const note = describeSortMismatch('new_arrivals', 'relevance');
  assert.match(note, /sorted these pages by Relevance/);
  assert.match(note, /not New Arrivals/);
  assert.match(note, /Treat the positions below as Relevance/);
});

test('the note names what to do about it', () => {
  // A warning with no next step gets read once and ignored afterwards.
  assert.match(describeSortMismatch('best_selling', 'relevance'), /recalibrate/i);
});

test('a mode that sorted correctly has nothing to describe', () => {
  assert.equal(describeSortMismatch('best_selling', null), null);
  assert.equal(describeSortMismatch('best_selling', undefined), null);
  assert.equal(
    describeSortMismatch('best_selling', 'best_selling'),
    null,
    'matching itself is not a mismatch',
  );
});

test('an unknown mode id still produces a readable note', () => {
  // Fiverr could name a sort we have never seen; falling back to the raw id is
  // ugly but honest, and better than rendering "undefined" at the user.
  const note = describeSortMismatch('best_selling', 'trending');
  assert.match(note, /sorted these pages by trending/);
  assert.doesNotMatch(note, /undefined/);
});

// --- scan progress -----------------------------------------------------------

const progressScan = (over = {}) => ({
  sortModes: ['relevance', 'best_selling'],
  maxPages: 10,
  cursor: { sortIndex: 0, page: 1 },
  status: 'running',
  ...over,
});

test('a scan that has not navigated yet reads as zero', () => {
  assert.equal(scanProgress(progressScan()), 0);
});

test('progress counts pages across every mode, not modes', () => {
  // Halfway through the first of two ten-page modes is a quarter of the work.
  assert.equal(scanProgress(progressScan({ cursor: { sortIndex: 0, page: 6 } })), 0.25);
});

test('finishing a mode carries its whole page budget', () => {
  assert.equal(scanProgress(progressScan({ cursor: { sortIndex: 1, page: 1 } })), 0.5);
});

test('progress never exceeds one, however the cursor overruns', () => {
  // Fiverr clamping an out-of-range page can push the cursor past maxPages.
  assert.equal(scanProgress(progressScan({ cursor: { sortIndex: 1, page: 99 } })), 1);
  assert.equal(scanProgress(progressScan({ cursor: { sortIndex: 9, page: 99 } })), 1);
});

test('a finished scan reads as complete even when it stopped early', () => {
  // Modes exhaust when results run out — the scan is done, not 30% done.
  const done = progressScan({ status: 'done', cursor: { sortIndex: 0, page: 4 } });
  assert.equal(scanProgress(done), 1);
});

test('a nonsensical scan yields zero rather than NaN', () => {
  for (const bad of [null, undefined, {}, { sortModes: [], maxPages: 10 }, { sortModes: ['a'], maxPages: 0 }]) {
    const value = scanProgress(bad);
    assert.equal(value, 0, JSON.stringify(bad));
    assert.ok(Number.isFinite(value), 'a NaN width would silently empty the bar');
  }
});

test('a missing cursor does not push progress negative', () => {
  const value = scanProgress(progressScan({ cursor: undefined }));
  assert.ok(value >= 0, 'a negative width would be dropped by the browser');
  assert.equal(value, 0);
});
