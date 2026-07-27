/**
 * Pins the worker's DOM sweep to the extension's.
 *
 * server/src/worker/collect.js duplicates collectCards() from src/content.js
 * because a classic content script cannot be imported and page.evaluate cannot
 * close over anything. Duplication drifts silently, so this loads one fixture in a
 * real browser, runs both implementations against it, and asserts they agree.
 *
 * If you change one and not the other, this fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { collectCardsInPage, readPageStateInPage } from '../src/worker/collect.js';
import { classifyCards } from '../../src/lib/cards.js';

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT_SCRIPT = join(here, '../../src/content.js');

/** A search page in miniature: organic cards, an injected one, and page furniture. */
const FIXTURE = `
<!doctype html><meta charset="utf-8"><title>logo design services | Fiverr</title>
<body>
  <nav><a href="/categories/graphics-design">Graphics</a></nav>

  <div data-gig-id="111_0">
    <a href="/seller_one/design-a-modern-logo?context_referrer=search_gigs_with_recommendations_row_1&source=top-bar" aria-label="Go to gig"></a>
    <img alt="I will design a modern logo" />
  </div>

  <div data-gig-id="222_1">
    <a href="/seller_two/make-a-wordmark-logo?context_referrer=search_gigs_with_recommendations_row_1&source=top-bar" aria-label="I will make a wordmark logo"></a>
  </div>

  <div data-gig-id="999_0">
    <a href="/rec_seller/recommended-logo?context_referrer=search_gigs_with_recommendations_row_1&source=recommendation_ftb_friendly" aria-label="Go to gig"></a>
    <h3>Recommended for you</h3>
  </div>

  <footer><a href="/support/contact">Support</a></footer>
</body>`;

const PAGE_URL = 'https://www.fiverr.com/search/gigs?query=logo%20design&source=top-bar';

let browser;
let page;

test.before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }),
  );
  await page.goto(PAGE_URL);
});

test.after(async () => {
  await browser?.close();
});

test('the worker sweep and the content script sweep agree exactly', async () => {
  const fromWorker = await page.evaluate(collectCardsInPage);

  // The content script is an IIFE that needs chrome.runtime to install; stub it,
  // then reach the collector through its documented test seam.
  const source = await readFile(CONTENT_SCRIPT, 'utf8');
  const fromExtension = await page.evaluate((script) => {
    window.chrome = { runtime: { onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}) } } };
    // eslint-disable-next-line no-eval
    eval(script);
    return window.__frtCollectCards();
  }, source);

  assert.deepEqual(fromWorker, fromExtension, 'collect.js has drifted from content.js');
  assert.equal(fromWorker.length, 3, 'all three tagged cards, injected one included');
});

test('the shared classifier drops the injected card from both', async () => {
  const raw = await page.evaluate(collectCardsInPage);
  const { organic, excluded } = classifyCards(raw, PAGE_URL);

  assert.deepEqual(
    organic.map((c) => c.username),
    ['seller_one', 'seller_two'],
    'recommendations row excluded',
  );
  assert.equal(excluded.recommendation_ftb_friendly, 1);
  assert.deepEqual(organic.map((c) => c.position), [1, 2], 'positions rank the survivors');
});

test('titles prefer a real label over Fiverr’s generic aria-label', async () => {
  const cards = await page.evaluate(collectCardsInPage);
  const byId = Object.fromEntries(cards.map((c) => [c.gigId, c]));
  assert.equal(byId['111_0'].title, 'I will design a modern logo', 'falls back to the image alt');
  assert.equal(byId['222_1'].title, 'I will make a wordmark logo', 'uses a meaningful aria-label');
});

test('page state reports a clean results page', async () => {
  const state = await page.evaluate(readPageStateInPage);
  assert.equal(state.botCheck, false);
  assert.equal(state.noResults, false);
  assert.equal(state.cardCount, 3);
});

test('a bot wall is detected rather than read as an empty page', async () => {
  // These must never look the same: one means retry later, the other means the
  // seller genuinely has no competition.
  const wall = await browser.newPage();
  await wall.route('**/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Just a moment...</title><body>Checking your browser before you continue.</body>',
    }),
  );
  await wall.goto(PAGE_URL);

  const state = await wall.evaluate(readPageStateInPage);
  assert.equal(state.botCheck, true);
  assert.equal(state.cardCount, 0);
  await wall.close();
});
