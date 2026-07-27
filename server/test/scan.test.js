/**
 * The scan loop, against a local fixture server.
 *
 * Covers the parts that only show up across multiple pages: position numbering
 * that continues from one page to the next, Fiverr's habit of clamping an
 * out-of-range page back to the last real one, and telling a bot wall apart from
 * an empty result set.
 *
 * The real network is out of reach from CI, so `urlFor` points the same loop at a
 * local server. Everything except the hostname is the production path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { scanKeyword } from '../src/worker/scan.js';

const ORGANIC = 'context_referrer=search_gigs_with_recommendations_row_1&source=top-bar';

const card = (index, seller) => `
  <div data-gig-id="${1000 + index}_${index}">
    <a href="/${seller}/gig-${index}?${ORGANIC}" aria-label="Gig by ${seller}"></a>
  </div>`;

const pageOf = (sellers, startIndex = 0) => `
  <!doctype html><meta charset="utf-8"><title>results</title>
  <body>${sellers.map((s, i) => card(startIndex + i, s)).join('')}</body>`;

const BOT_WALL = `
  <!doctype html><meta charset="utf-8"><title>Just a moment...</title>
  <body>Checking your browser before you continue.</body>`;

const EMPTY = `
  <!doctype html><meta charset="utf-8"><title>results</title>
  <body><p>No results found for that search.</p></body>`;

/** Serves whatever the current scenario says for ?page=N. */
function startServer(pages) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const page = Number(url.searchParams.get('page') || 1);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pages[page] ?? pages[1]);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const scanAgainst = async (server, options = {}) => {
  const { port } = server.address();
  return scanKeyword({
    keyword: 'logo design',
    maxPages: 3,
    delayMs: 0,
    // The fixture server responds instantly; no need to sit through the full
    // hydration wait on the pages that deliberately have no cards.
    cardWaitMs: 1200,
    urlFor: (page) => `http://127.0.0.1:${port}/search?page=${page}`,
    ...options,
  });
};

test('positions continue across pages instead of restarting', async () => {
  const server = await startServer({
    1: pageOf(['seller_a', 'seller_b'], 0),
    2: pageOf(['seller_c', 'seller_d'], 0),
    3: pageOf(['seller_e'], 0),
  });
  try {
    const outcome = await scanAgainst(server);
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.pagesScanned, 3);
    assert.deepEqual(
      outcome.results.map((r) => [r.position, r.username]),
      [
        [1, 'seller_a'],
        [2, 'seller_b'],
        [3, 'seller_c'],
        [4, 'seller_d'],
        [5, 'seller_e'],
      ],
      'page 2 starts at 3, not back at 1',
    );
  } finally {
    server.close();
  }
});

test('a repeated page stops the scan rather than double-counting', async () => {
  // Fiverr clamps an out-of-range page number back to the last real page. Without
  // this check the same gigs would be recorded again at fresh positions.
  const repeated = pageOf(['seller_a', 'seller_b'], 0);
  const server = await startServer({ 1: repeated, 2: repeated, 3: repeated });
  try {
    const outcome = await scanAgainst(server);
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.results.length, 2, 'page 2 recognised as a repeat of page 1');
    assert.equal(outcome.pagesScanned, 2);
  } finally {
    server.close();
  }
});

test('a bot wall is reported as blocked, not as no results', async () => {
  const server = await startServer({ 1: BOT_WALL });
  try {
    const outcome = await scanAgainst(server);
    assert.equal(outcome.status, 'blocked');
    assert.match(outcome.error, /Bot check/);
    assert.equal(outcome.results, undefined, 'nothing is recorded from a wall');
  } finally {
    server.close();
  }
});

test('a genuinely empty result set is reported as empty', async () => {
  const server = await startServer({ 1: EMPTY });
  try {
    const outcome = await scanAgainst(server);
    assert.equal(outcome.status, 'empty');
    assert.equal(outcome.pagesScanned, 0);
  } finally {
    server.close();
  }
});

test('a wall on a later page keeps the pages that succeeded', async () => {
  // Fiverr walls the second navigation more often than the first, and page 1 is
  // 48 positions — enough to be worth keeping. It is reported as `partial` rather
  // than `ok` so nothing downstream mistakes it for a complete result set.
  const server = await startServer({ 1: pageOf(['seller_a', 'seller_b'], 0), 2: BOT_WALL });
  try {
    const outcome = await scanAgainst(server);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.pagesScanned, 1);
    assert.deepEqual(outcome.results.map((r) => r.username), ['seller_a', 'seller_b']);
    assert.match(outcome.error, /Bot check/);
  } finally {
    server.close();
  }
});

test('a wall on the very first page yields nothing at all', async () => {
  const server = await startServer({ 1: BOT_WALL });
  try {
    const outcome = await scanAgainst(server);
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.results, undefined);
  } finally {
    server.close();
  }
});

test('diagnostics record what was seen and dropped per page', async () => {
  const server = await startServer({ 1: pageOf(['seller_a', 'seller_b'], 0) });
  try {
    const outcome = await scanAgainst(server, { maxPages: 1 });
    assert.equal(outcome.diagnostics.pages.length, 1);
    assert.deepEqual(outcome.diagnostics.pages[0], {
      page: 1,
      rawCards: 2,
      organic: 2,
      excluded: {},
      warnings: [],
    });
  } finally {
    server.close();
  }
});
