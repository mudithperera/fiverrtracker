import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anchorsToCards,
  matchCards,
  normalizeUsername,
  pageSignature,
  parseGigPath,
  summarizeBySortMode,
} from '../src/lib/extract.js';

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

test('anchorsToCards dedupes the multiple links inside one gig card', () => {
  // A Fiverr card links to the same gig from the thumbnail, the title, and an
  // overlay. Counting each separately would inflate every position number.
  const anchors = [
    { pathname: '/seller_one/make-a-logo', url: 'https://www.fiverr.com/seller_one/make-a-logo', title: '' },
    {
      pathname: '/seller_one/make-a-logo',
      url: 'https://www.fiverr.com/seller_one/make-a-logo',
      title: 'I will make a modern minimalist logo',
    },
    { pathname: '/categories/graphics-design', url: 'x', title: 'Graphics' },
    { pathname: '/seller_two/design-a-banner', url: 'https://www.fiverr.com/seller_two/design-a-banner', title: 'Banner' },
  ];

  const cards = anchorsToCards(anchors);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].username, 'seller_one');
  assert.equal(cards[0].title, 'I will make a modern minimalist logo', 'keeps the richest title');
  assert.equal(cards[1].username, 'seller_two');
});

test('anchorsToCards preserves DOM order', () => {
  const cards = anchorsToCards([
    { pathname: '/aaa_seller/gig-one', url: '1', title: '' },
    { pathname: '/bbb_seller/gig-two', url: '2', title: '' },
    { pathname: '/ccc_seller/gig-three', url: '3', title: '' },
  ]);
  assert.deepEqual(cards.map((c) => c.username), ['aaa_seller', 'bbb_seller', 'ccc_seller']);
});

test('matchCards reports page position and absolute position', () => {
  const cards = anchorsToCards([
    { pathname: '/other_seller/gig-a', url: 'a', title: 'A' },
    { pathname: '/target_seller/gig-b', url: 'b', title: 'B' },
    { pathname: '/third_seller/gig-c', url: 'c', title: 'C' },
  ]);

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
});

test('matchCards finds every gig from the same seller', () => {
  const cards = anchorsToCards([
    { pathname: '/target_seller/gig-a', url: 'a', title: 'A' },
    { pathname: '/other_seller/gig-b', url: 'b', title: 'B' },
    { pathname: '/target_seller/gig-c', url: 'c', title: 'C' },
  ]);
  const findings = matchCards(cards, 'target_seller', {
    sortMode: 'best_selling',
    page: 1,
    positionOffset: 0,
  });
  assert.deepEqual(findings.map((f) => f.positionOnPage), [1, 3]);
});

test('matchCards returns nothing for an unknown seller', () => {
  const cards = anchorsToCards([{ pathname: '/some_seller/gig-a', url: 'a', title: 'A' }]);
  assert.deepEqual(matchCards(cards, 'nobody_here', { sortMode: 'relevance', page: 1, positionOffset: 0 }), []);
  assert.deepEqual(matchCards(cards, '', { sortMode: 'relevance', page: 1, positionOffset: 0 }), []);
});

test('pageSignature detects a repeated page', () => {
  const a = anchorsToCards([
    { pathname: '/one_seller/gig-a', url: 'a', title: '' },
    { pathname: '/two_seller/gig-b', url: 'b', title: '' },
  ]);
  const b = anchorsToCards([
    { pathname: '/one_seller/gig-a', url: 'a', title: '' },
    { pathname: '/two_seller/gig-b', url: 'b', title: '' },
  ]);
  const c = anchorsToCards([{ pathname: '/three_seller/gig-c', url: 'c', title: '' }]);

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
