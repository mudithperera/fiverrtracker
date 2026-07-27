import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchCards,
  normalizeUsername,
  pageSignature,
  parseGigPath,
  summarizeBySortMode,
} from '../src/lib/extract.js';

/** Shorthand for an organic card as classifyCards() would hand it over. */
const card = (username, slug, index, title = '') => ({
  username,
  slug,
  index,
  url: `https://www.fiverr.com/${username}/${slug}`,
  title,
});

test('normalizeUsername strips the @ prefix', () => {
  // The failure that motivated this project: "@handle" typed into the box never
  // matched the bare handle in Fiverr's gig URLs, so every scan reported not-found.
  assert.equal(normalizeUsername('@janakakumara991'), 'janakakumara991');
  assert.equal(normalizeUsername('janakakumara991'), 'janakakumara991');
  assert.equal(normalizeUsername('  @JanakaKumara991  '), 'janakakumara991');
});

test('normalizeUsername accepts pasted profile and gig URLs', () => {
  assert.equal(normalizeUsername('https://www.fiverr.com/janakakumara991'), 'janakakumara991');
  assert.equal(
    normalizeUsername('https://www.fiverr.com/janakakumara991/design-a-modern-logo'),
    'janakakumara991',
  );
  assert.equal(normalizeUsername('fiverr.com/janakakumara991'), 'janakakumara991');
  assert.equal(normalizeUsername('www.fiverr.com/de/janakakumara991/logo'), 'janakakumara991');
});

test('normalizeUsername rejects empty input', () => {
  assert.equal(normalizeUsername(''), '');
  assert.equal(normalizeUsername('   '), '');
  assert.equal(normalizeUsername(null), '');
  assert.equal(normalizeUsername(undefined), '');
});

test('parseGigPath extracts the seller handle from a gig path', () => {
  assert.deepEqual(parseGigPath('/janakakumara991/design-a-modern-logo'), {
    username: 'janakakumara991',
    slug: 'design-a-modern-logo',
  });
});

test('parseGigPath strips locale prefixes', () => {
  assert.deepEqual(parseGigPath('/de/janakakumara991/design-a-modern-logo'), {
    username: 'janakakumara991',
    slug: 'design-a-modern-logo',
  });
});

test('parseGigPath rejects Fiverr routes that are not sellers', () => {
  assert.equal(parseGigPath('/categories/graphics-design'), null);
  assert.equal(parseGigPath('/search/gigs'), null);
  assert.equal(parseGigPath('/pro/some-thing'), null);
  assert.equal(parseGigPath('/inbox/conversation'), null);
});

test('parseGigPath rejects non-gig shapes', () => {
  assert.equal(parseGigPath('/janakakumara991'), null, 'profile link is not a gig');
  assert.equal(parseGigPath('/'), null);
  assert.equal(parseGigPath(''), null);
  assert.equal(parseGigPath('/ab/cd'), null, 'handles are at least 3 chars');
});

test('matchCards uses Fiverr’s own index for position, not array order', () => {
  // The index comes from data-gig-id="<gigId>_<index>". Trusting array order was
  // how promoted and recommended cards used to shift every position number.
  const cards = [
    card('other_seller', 'gig-a', 0, 'A'),
    card('target_seller', 'gig-b', 1, 'B'),
    card('third_seller', 'gig-c', 2, 'C'),
  ];

  const findings = matchCards(cards, 'target_seller', {
    sortMode: 'relevance',
    page: 3,
    positionOffset: 96, // gigs actually counted on pages 1-2
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].positionOnPage, 2);
  assert.equal(findings[0].absolutePosition, 98);
  assert.equal(findings[0].page, 3);
  assert.equal(findings[0].gigTitle, 'B');
  assert.equal(findings[0].gigKey, 'target_seller/gig-b');
});

test('matchCards falls back to array order when a card has no index', () => {
  const cards = [
    { username: 'other_seller', slug: 'gig-a', url: 'a', title: 'A' },
    { username: 'target_seller', slug: 'gig-b', url: 'b', title: 'B' },
  ];
  const findings = matchCards(cards, 'target_seller', {
    sortMode: 'relevance',
    page: 1,
    positionOffset: 0,
  });
  assert.equal(findings[0].positionOnPage, 2);
});

test('matchCards finds every gig from the same seller', () => {
  const cards = [
    card('target_seller', 'gig-a', 0, 'A'),
    card('other_seller', 'gig-b', 1, 'B'),
    card('target_seller', 'gig-c', 2, 'C'),
  ];
  const findings = matchCards(cards, 'target_seller', {
    sortMode: 'best_selling',
    page: 1,
    positionOffset: 0,
  });
  assert.deepEqual(findings.map((f) => f.positionOnPage), [1, 3]);
});

test('matchCards returns nothing for an unknown seller', () => {
  const cards = [card('some_seller', 'gig-a', 0, 'A')];
  assert.deepEqual(matchCards(cards, 'nobody_here', { sortMode: 'relevance', page: 1, positionOffset: 0 }), []);
  assert.deepEqual(matchCards(cards, '', { sortMode: 'relevance', page: 1, positionOffset: 0 }), []);
});

test('pageSignature detects a repeated page', () => {
  const a = [card('one_seller', 'gig-a', 0), card('two_seller', 'gig-b', 1)];
  const b = [card('one_seller', 'gig-a', 0), card('two_seller', 'gig-b', 1)];
  const c = [card('three_seller', 'gig-c', 0)];

  assert.equal(pageSignature(a), pageSignature(b));
  assert.notEqual(pageSignature(a), pageSignature(c));
});

test('summarizeBySortMode picks the best position per sort mode', () => {
  const scan = {
    sortModes: ['relevance', 'best_selling'],
    progress: {
      relevance: { pagesScanned: 4, exhausted: false },
      best_selling: { pagesScanned: 10, exhausted: false },
    },
    findings: [
      { sortMode: 'relevance', page: 2, positionOnPage: 5, absolutePosition: 53 },
      { sortMode: 'relevance', page: 1, positionOnPage: 9, absolutePosition: 9 },
    ],
  };

  const summary = summarizeBySortMode(scan);
  assert.equal(summary.relevance.found, true);
  assert.equal(summary.relevance.best.absolutePosition, 9);
  assert.equal(summary.relevance.all.length, 2);
  assert.equal(summary.best_selling.found, false);
  assert.equal(summary.best_selling.pagesScanned, 10);
});
