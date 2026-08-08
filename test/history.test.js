import test from 'node:test';
import assert from 'node:assert/strict';

import { HISTORY_KEY, scanToHistoryEntry, trendFor } from '../src/lib/history.js';

/**
 * The smallest chrome.storage.local that history.js actually uses. Real enough to
 * exercise trendFor without a browser, which is the point of keeping this module
 * free of DOM.
 */
function stubStorage(entries) {
  globalThis.chrome = {
    storage: { local: { async get() { return { [HISTORY_KEY]: entries }; } } },
  };
}

const scan = (over = {}) => ({
  id: 's1',
  keyword: 'logo design',
  username: 'someseller',
  sortModes: ['relevance'],
  maxPages: 5,
  startedAt: 1,
  finishedAt: 2,
  findings: [
    {
      sortMode: 'relevance',
      page: 1,
      positionOnPage: 4,
      absolutePosition: 4,
      gigTitle: 'a logo',
      gigUrl: 'https://www.fiverr.com/someseller/a-logo',
    },
  ],
  progress: { relevance: { pagesScanned: 1 } },
  ...over,
});

test('a scan that never routed anywhere records no country', () => {
  const entry = scanToHistoryEntry(scan());
  assert.equal(entry.country, null);
  assert.equal(entry.rows[0].country, null);
});

test('the recorded country is the one the route was confirmed for', () => {
  const entry = scanToHistoryEntry(scan({ routedCountry: 'de' }));
  assert.equal(entry.country, 'de');
  assert.equal(entry.rows[0].country, 'de');
});

test('asking for a country is not enough to be recorded as one', () => {
  // `country` is the request; `routedCountry` is what the worker confirmed after
  // the proxy came up. A scan that died before that must not leave rows claiming
  // to be German rankings — nobody could tell afterwards that they were not.
  const entry = scanToHistoryEntry(scan({ country: 'de' }));
  assert.equal(entry.country, null, 'the request alone proves nothing');
  assert.equal(entry.rows[0].country, null);
});

test('a not-found row still carries the country it was measured from', () => {
  const entry = scanToHistoryEntry(scan({ routedCountry: 'de', findings: [] }));
  assert.equal(entry.rows[0].found, false);
  assert.equal(entry.rows[0].country, 'de', 'absence from Germany is a German result');
});

test('a trend does not mix countries into one series', async () => {
  stubStorage([
    { keyword: 'logo design', username: 'someseller', country: 'de', finishedAt: 30, rows: [{ sortMode: 'relevance', found: true, absolutePosition: 40, page: 1 }] },
    { keyword: 'logo design', username: 'someseller', country: null, finishedAt: 20, rows: [{ sortMode: 'relevance', found: true, absolutePosition: 4, page: 1 }] },
    { keyword: 'logo design', username: 'someseller', country: null, finishedAt: 10, rows: [{ sortMode: 'relevance', found: true, absolutePosition: 6, page: 1 }] },
  ]);

  const home = await trendFor({ keyword: 'logo design', username: 'someseller', sortMode: 'relevance' });
  assert.deepEqual(
    home.map((p) => p.absolutePosition),
    [6, 4],
    'the German scan is a different series, not a crash from 4 to 40',
  );

  const german = await trendFor({
    keyword: 'logo design',
    username: 'someseller',
    sortMode: 'relevance',
    country: 'de',
  });
  assert.deepEqual(german.map((p) => p.absolutePosition), [40]);
});

test('history written before countries existed reads as the home series', async () => {
  // Old entries have no `country` key at all, not `country: null`.
  stubStorage([
    { keyword: 'logo design', username: 'someseller', finishedAt: 10, rows: [{ sortMode: 'relevance', found: true, absolutePosition: 7, page: 1 }] },
  ]);

  const home = await trendFor({ keyword: 'logo design', username: 'someseller', sortMode: 'relevance' });
  assert.deepEqual(home.map((p) => p.absolutePosition), [7], 'missing must not mean invisible');
});

test('a gig that dropped out is kept in the series rather than skipped', async () => {
  stubStorage([
    { keyword: 'logo design', username: 'someseller', country: 'de', finishedAt: 20, rows: [{ sortMode: 'relevance', found: false }] },
    { keyword: 'logo design', username: 'someseller', country: 'de', finishedAt: 10, rows: [{ sortMode: 'relevance', found: true, absolutePosition: 12, page: 1 }] },
  ]);

  const trend = await trendFor({
    keyword: 'logo design',
    username: 'someseller',
    sortMode: 'relevance',
    country: 'de',
  });
  assert.deepEqual(trend.map((p) => p.absolutePosition), [12, null]);
});
