import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCards,
  describeExclusions,
  describeIndices,
  injectedExclusions,
  parseCardId,
  readParam,
} from '../src/lib/cards.js';

/**
 * Fixtures below mirror what a real Fiverr search page returned when this was
 * diagnosed: 48 organic results indexed 0-47, plus a 4-card "recommendations row"
 * carrying its own 0-3 index sequence and a `source` of its own. Counting that row
 * as results is what made one seller appear to rank on every single page.
 */
const PAGE_URL =
  'https://www.fiverr.com/search/gigs?query=logo%20design&source=top-bar&search_in=everywhere';

const ORGANIC_CONTEXT = 'search_gigs_with_recommendations_row_1';

const organicCard = (index, username = `seller${index}`) => ({
  gigId: `${100000 + index}_${index}`,
  href: `https://www.fiverr.com/${username}/design-a-logo-${index}?context_referrer=${ORGANIC_CONTEXT}&source=top-bar&ref_ctx_id=abc`,
  title: `Logo gig ${index}`,
});

const recommendationCard = (index) => ({
  gigId: `${900000 + index}_${index}`,
  href: `https://www.fiverr.com/rec_seller${index}/recommended-logo-${index}?context_referrer=${ORGANIC_CONTEXT}&source=recommendation_ftb_friendly&ref_ctx_id=abc`,
  title: `Recommended ${index}`,
});

/** Recommendations render above the results, exactly as Fiverr orders them. */
const fullPage = () => [
  ...[0, 1, 2, 3].map(recommendationCard),
  ...Array.from({ length: 48 }, (_, i) => organicCard(i)),
];

test('parseCardId splits data-gig-id into gig id and page index', () => {
  assert.deepEqual(parseCardId('238413205_0'), { gigId: '238413205', index: 0 });
  assert.deepEqual(parseCardId('251331426_47'), { gigId: '251331426', index: 47 });
  assert.equal(parseCardId('no-index-here'), null);
  assert.equal(parseCardId(''), null);
  assert.equal(parseCardId(null), null);
});

test('readParam reads a query parameter off a relative or absolute URL', () => {
  assert.equal(readParam('/a/b?source=top-bar', 'source'), 'top-bar');
  assert.equal(readParam(PAGE_URL, 'source'), 'top-bar');
  assert.equal(readParam(PAGE_URL, 'nothing'), null);
  assert.equal(readParam(null, 'source'), null);
});

test('classifyCards keeps the 48 real results and drops the recommendations row', () => {
  const { organic, excluded, contiguous } = classifyCards(fullPage(), PAGE_URL);

  assert.equal(organic.length, 48, 'one card per real search result');
  assert.equal(contiguous, true, 'Fiverr indexes results 0..47');
  assert.equal(excluded.recommendation_ftb_friendly, 4);
  assert.equal(organic[0].position, 1, 'ranks are 1-based');
  assert.equal(organic[47].position, 48);
  assert.equal(organic[47].pageIndex, 47);
  assert.ok(
    !organic.some((c) => c.username.startsWith('rec_seller')),
    'no recommended card survived',
  );
});

test('position is the rank among real results, not Fiverr’s raw index', () => {
  // Fiverr numbers every card in the grid, injected ones included. A gig sitting
  // after an injected card would be reported one slot too low if we used the raw
  // index — this is the "0-34, 36-47" case seen in the wild.
  const cards = [
    organicCard(0, 'first_seller'),
    {
      gigId: '999_1',
      href: `https://www.fiverr.com/promo/injected?context_referrer=${ORGANIC_CONTEXT}&source=choice_modalities_pricing`,
      title: 'Injected',
    },
    organicCard(2, 'third_seller'),
  ];

  const { organic, contiguous, warnings } = classifyCards(cards, PAGE_URL);
  assert.deepEqual(organic.map((c) => c.position), [1, 2]);
  assert.deepEqual(organic.map((c) => c.pageIndex), [0, 2]);
  assert.equal(organic[1].username, 'third_seller');
  assert.equal(contiguous, true, 'the hole at index 1 is explained by the exclusion');
  assert.deepEqual(warnings, [], 'an explained gap must not warn');
});

test('classifyCards survives a sorted page, where every source changes', () => {
  // Picking a sort sets source=sorting_by on the page URL *and* on every result
  // card. Gating organic cards on the page URL's original source would have
  // excluded all 48 and reported "not found" on every sorted page.
  const sortedUrl =
    'https://www.fiverr.com/search/gigs?query=minimalist%20logo&source=sorting_by&filter=rating';
  const cards = Array.from({ length: 20 }, (_, i) => ({
    gigId: `${100000 + i}_${i}`,
    href: `https://www.fiverr.com/seller${i}/a-logo-${i}?context_referrer=${ORGANIC_CONTEXT}&source=sorting_by`,
    title: `Gig ${i}`,
  }));
  cards.push({
    gigId: '900_20',
    href: `https://www.fiverr.com/rec/injected?context_referrer=${ORGANIC_CONTEXT}&source=recommendation_ftb_friendly`,
    title: 'Recommended',
  });

  const { organic, excluded, dominantSource } = classifyCards(cards, sortedUrl);
  assert.equal(organic.length, 20);
  assert.equal(dominantSource, 'sorting_by');
  assert.equal(excluded.recommendation_ftb_friendly, 1);
});

test('classifyCards drops navigation links that carry no context_referrer', () => {
  // Category tree, filter dropdowns, pagination and footer links are gig-shaped but
  // have no context_referrer at all. Counting them inflated every position.
  const cards = [
    organicCard(0),
    {
      gigId: '555_1',
      href: 'https://www.fiverr.com/some_seller/a-gig-in-the-nav?source=category_tree',
      title: 'Nav link',
    },
  ];
  const { organic, excluded } = classifyCards(cards, PAGE_URL);
  assert.equal(organic.length, 1);
  assert.equal(excluded['no-context-referrer'], 1);
});

test('classifyCards excludes an unknown injected source rather than counting it', () => {
  // Fails safe: a module Fiverr adds later is bucketed and visible, not silently
  // folded into the organic count.
  const cards = [
    organicCard(0),
    {
      gigId: '777_1',
      href: `https://www.fiverr.com/promo_seller/a-promoted-gig?context_referrer=${ORGANIC_CONTEXT}&source=some_new_module`,
      title: 'Promoted',
    },
  ];
  const { organic, excluded } = classifyCards(cards, PAGE_URL);
  assert.equal(organic.length, 1);
  assert.equal(excluded.some_new_module, 1);
});

test('classifyCards catches promoted sources even when the page URL has no source', () => {
  const urlWithoutSource = 'https://www.fiverr.com/search/gigs?query=logo%20design';
  const cards = [
    {
      gigId: '111_0',
      href: `https://www.fiverr.com/real_seller/a-real-gig?context_referrer=${ORGANIC_CONTEXT}`,
      title: 'Real',
    },
    {
      gigId: '222_1',
      href: `https://www.fiverr.com/ad_seller/a-promoted-gig?context_referrer=${ORGANIC_CONTEXT}&source=promoted_gigs`,
      title: 'Promoted',
    },
  ];
  const { organic, excluded } = classifyCards(cards, urlWithoutSource);
  assert.equal(organic.length, 1);
  assert.equal(organic[0].username, 'real_seller');
  assert.equal(excluded.promoted_gigs, 1);
});

test('classifyCards dedupes nested wrappers for the same gig', () => {
  // Fiverr nests .basic-gig-card inside a wrapper of the same class; if both ever
  // carry the id, the gig must still count once.
  const duplicate = { ...organicCard(0), title: 'A much longer and better title' };
  const { organic } = classifyCards([organicCard(0), duplicate], PAGE_URL);
  assert.equal(organic.length, 1);
  assert.equal(organic[0].title, 'A much longer and better title', 'keeps the richest title');
});

test('classifyCards warns when a hole in the numbering is not explained by an exclusion', () => {
  // A card that never reached us at all — nothing was filtered, so the gap means a
  // real result went missing and every position after it is too low.
  const organicOnly = Array.from({ length: 48 }, (_, i) => organicCard(i));
  const cards = organicOnly.filter((c) => !c.gigId.endsWith('_12'));
  const { organic, contiguous, warnings } = classifyCards(cards, PAGE_URL);

  assert.equal(organic.length, 47);
  assert.equal(contiguous, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be read/);
});

test('classifyCards reports unreadable cards rather than skipping them quietly', () => {
  const { organic, excluded } = classifyCards(
    [
      organicCard(0),
      { gigId: 'garbage', href: 'https://www.fiverr.com/x/y' },
      { gigId: '9_1' }, // a wrapper with no link in it at all
      { gigId: '9_2', href: 'https://www.fiverr.com/profile-only' },
    ],
    PAGE_URL,
  );
  assert.equal(organic.length, 1);
  assert.equal(excluded['unreadable-id'], 1);
  assert.equal(excluded['unreadable-link'], 1);
  assert.equal(excluded['not-a-gig-link'], 1);
});

test('classifyCards handles an empty page without throwing', () => {
  const { organic, contiguous, warnings } = classifyCards([], PAGE_URL);
  assert.deepEqual(organic, []);
  assert.equal(contiguous, true);
  assert.deepEqual(warnings, []);
});

test('injectedExclusions hides page furniture and keeps injected modules', () => {
  const buckets = {
    'no-context-referrer': 41,
    'not-a-gig-link': 3,
    recommendation_ftb_friendly: 4,
    promoted_gigs: 5,
  };
  assert.deepEqual(injectedExclusions(buckets), {
    recommendation_ftb_friendly: 4,
    promoted_gigs: 5,
  });
});

test('describeExclusions orders buckets by size', () => {
  assert.equal(
    describeExclusions({ recommendation_ftb_friendly: 4, promoted_gigs: 9 }),
    '9 promoted_gigs, 4 recommendation_ftb_friendly',
  );
  assert.equal(describeExclusions({}), '');
});

test('describeIndices collapses runs for the warning message', () => {
  const cards = [0, 1, 2, 5, 6, 9].map((pageIndex) => ({ pageIndex }));
  assert.equal(describeIndices(cards), '0-2, 5-6, 9');
  assert.equal(describeIndices([]), 'none');
});
