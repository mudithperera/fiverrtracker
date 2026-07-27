import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SORT_MODE_IDS,
  buildSearchUrl,
  diffSortParams,
  fallbackCalibration,
} from '../src/lib/sortmodes.js';
import { advanceCursor, createScan } from '../src/lib/scan-state.js';

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
  const url = new URL(buildSearchUrl('logo', 1, 'best_selling', { params: {} }));
  assert.equal(url.searchParams.get('sort_by'), 'best_selling');
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
    assert.deepEqual(scan.progress[id], { pagesScanned: 0, gigsSeen: 0, exhausted: false });
  }
});
