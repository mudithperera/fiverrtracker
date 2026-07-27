/**
 * The in-page card sweep, for Playwright.
 *
 * This mirrors `collectCards()` in src/content.js. It has to be duplicated rather
 * than imported: the content script is a classic script (Chrome does not support
 * `type: module` for declared content scripts) and this body is serialised into a
 * browser context by `page.evaluate`, so it cannot close over anything either.
 *
 * Duplication is a drift risk, so test/collect.test.js runs both against the same
 * fixture and asserts they agree. If you change one, that test fails until you
 * change the other.
 *
 * Everything downstream — deciding which cards are real results, and at what
 * position — is *not* duplicated: the worker imports src/lib/cards.js, the same
 * module the extension uses, so the daily number and the number the panel shows
 * cannot disagree.
 */

/** Runs inside the page. Kept dependency-free and self-contained on purpose. */
export function collectCardsInPage() {
  const CARD_SELECTOR = '[data-gig-id]';
  const GIG_PATH_HINT = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?[a-z0-9_]{3,}\/[a-z0-9][a-z0-9-]{2,}/i;

  const pathnameOf = (anchor) => {
    const href = anchor.getAttribute('href');
    if (!href) return null;
    try {
      return new URL(href, location.origin).pathname;
    } catch {
      return null;
    }
  };

  const gigAnchorIn = (wrapper) => {
    const anchors = Array.from(wrapper.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const path = pathnameOf(anchor);
      if (path && GIG_PATH_HINT.test(path)) return anchor;
    }
    return anchors[0] || null;
  };

  const cardTitle = (wrapper, anchor) => {
    const aria = anchor && anchor.getAttribute('aria-label');
    const trimmedAria = aria ? aria.trim() : '';
    // Fiverr uses a generic "Go to gig" aria-label, which tells the user nothing.
    if (trimmedAria && !/^go to gig$/i.test(trimmedAria)) return trimmedAria.slice(0, 200);
    const img = wrapper.querySelector('img[alt]');
    const alt = img && img.getAttribute('alt') ? img.getAttribute('alt').trim() : '';
    if (alt) return alt.slice(0, 200);
    const heading = wrapper.querySelector('h1, h2, h3, h4, p, [role="heading"]');
    const text = ((heading && heading.textContent) || '').trim().replace(/\s+/g, ' ');
    return text ? text.slice(0, 200) : '';
  };

  const cards = [];
  document.querySelectorAll(CARD_SELECTOR).forEach((wrapper) => {
    const anchor = gigAnchorIn(wrapper);
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    let absolute;
    try {
      absolute = new URL(href, location.origin).toString();
    } catch {
      return;
    }
    cards.push({
      gigId: wrapper.getAttribute('data-gig-id') || '',
      href: absolute,
      title: cardTitle(wrapper, anchor),
    });
  });
  return cards;
}

/** Bot-wall and empty-result detection, also run inside the page. */
export function readPageStateInPage() {
  const BOT_CHECK_PATTERNS = [
    /just a moment/i,
    /checking your browser/i,
    /access denied/i,
    /unusual traffic/i,
    /verify you are human/i,
    /press and hold/i,
  ];
  const NO_RESULTS_PATTERNS = [
    /no results found/i,
    /we couldn'?t find/i,
    /didn'?t match any/i,
    /try a different search/i,
    /0 services available/i,
  ];

  const title = document.title || '';
  const bodyText = ((document.body && document.body.innerText) || '').slice(0, 6000);

  const captcha = Boolean(
    document.querySelector('#px-captcha, .px-captcha-container, [id*="px-captcha"]'),
  );
  const challengeFrame = Boolean(
    document.querySelector('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="challenge" i]'),
  );
  const titleWall = BOT_CHECK_PATTERNS.some((re) => re.test(title));
  // Bot walls are tiny pages; don't scan a full search page's text for these.
  const bodyWall = bodyText.length < 1200 && BOT_CHECK_PATTERNS.some((re) => re.test(bodyText));

  return {
    botCheck: captcha || challengeFrame || titleWall || bodyWall,
    noResults: NO_RESULTS_PATTERNS.some((re) => re.test(bodyText)),
    title,
    cardCount: document.querySelectorAll('[data-gig-id]').length,
  };
}
