/**
 * Pure gig-matching logic. Deliberately DOM-free so it can be unit tested and so
 * the content script stays a dumb scraper — the content script hands back raw
 * cards, everything below decides what counts as a match.
 */

/**
 * Normalize whatever the user typed into a bare Fiverr handle.
 *
 * Accepts `@name`, `name`, `fiverr.com/name`, `https://www.fiverr.com/name/gig-slug`,
 * and locale-prefixed URLs like `fiverr.com/de/name`. Returns '' if nothing usable.
 *
 * This matters: Fiverr's gig links contain the bare handle, so comparing a typed
 * `@handle` straight against the URL segment never matches and the scan reports a
 * false "not found".
 */
export function normalizeUsername(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (!value) return '';

  // Pull the handle out of a pasted profile or gig URL.
  const urlish = value.match(/^(?:https?:\/\/)?(?:[\w-]+\.)*fiverr\.com\/(.+)$/i);
  if (urlish) {
    value = urlish[1];
  }

  value = value.replace(/^\/+/, '');
  value = value.split(/[?#]/)[0];

  let segments = value.split('/').filter(Boolean);
  segments = stripLocalePrefix(segments);
  if (segments.length) value = segments[0];

  value = value.trim().replace(/^@+/, '');
  return value.toLowerCase();
}

/** Fiverr serves locale-prefixed paths such as /de/username/gig-slug. */
const LOCALE_SEGMENTS = new Set([
  'ar', 'da', 'de', 'en', 'es', 'fi', 'fr', 'he', 'id', 'it', 'ja', 'ko', 'nl',
  'no', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'vi', 'zh', 'zh-cn', 'zh-tw', 'pt-br',
]);

export function stripLocalePrefix(segments) {
  if (segments.length > 1 && LOCALE_SEGMENTS.has(segments[0].toLowerCase())) {
    return segments.slice(1);
  }
  return segments;
}

/**
 * First path segments that are Fiverr pages, not seller handles. Anything here can
 * never be a username, so `/categories/graphics-design` is not read as a gig by
 * user "categories".
 */
export const NON_SELLER_SEGMENTS = new Set([
  'about', 'affiliates', 'api', 'become_seller', 'blog', 'business', 'buying',
  'campaigns', 'cart', 'categories', 'category', 'checkout', 'community', 'cp',
  'dashboard', 'experience', 'favorites', 'gig_categories', 'gigs', 'go', 'help',
  'inbox', 'invite', 'join', 'jobs', 'landing_pages', 'logo-maker', 'login', 'logout',
  'lp', 'manage_gigs', 'my_orders', 'news', 'notifications', 'orders', 'pages',
  'payments', 'privacy_policy', 'pro', 'resources', 'search', 'seller_dashboard',
  's', 'selling', 'settings', 'share', 'signin', 'signup', 'sitemap', 'start_selling',
  'studios', 'support', 'terms_of_service', 'users', 'watchlist', 'workspace',
]);

/**
 * Decide whether a Fiverr pathname looks like a gig URL, and pull the handle out.
 * @returns {{username: string, slug: string}|null}
 */
export function parseGigPath(pathname) {
  if (typeof pathname !== 'string') return null;
  const clean = pathname.split(/[?#]/)[0];
  let segments = clean.split('/').filter(Boolean);
  segments = stripLocalePrefix(segments);
  if (segments.length < 2) return null;

  const [username, slug] = segments;
  const handle = username.toLowerCase();
  if (NON_SELLER_SEGMENTS.has(handle)) return null;
  // Handles are alphanumeric plus underscore; anything else is a Fiverr route.
  if (!/^[a-z0-9_]{3,}$/.test(handle)) return null;
  if (!slug || slug.length < 3) return null;

  return { username: handle, slug };
}

/**
 * Fingerprint of a results page, used to detect Fiverr clamping an out-of-range
 * page number back to the last real page — which would otherwise look like the
 * same gigs ranking on every remaining page.
 */
export function pageSignature(cards) {
  return cards
    .slice(0, 6)
    .map((c) => `${c.username}/${c.slug}`)
    .join('|');
}

/**
 * Turn the raw cards scraped from one search page into findings for one seller.
 *
 * @param {Array<{username:string, url:string, title:string, index:number}>} cards
 *        Organic gig cards from classifyCards(), ordered by Fiverr's own index.
 * @param {string} normalizedUsername Output of normalizeUsername().
 * @param {{sortMode:string, page:number, positionOffset:number}} ctx
 *        `positionOffset` is the number of organic gigs counted on all previous
 *        pages of this sort mode, so absolute position reflects what was actually
 *        observed rather than assuming every page was full.
 */
export function matchCards(cards, normalizedUsername, ctx) {
  if (!normalizedUsername) return [];
  const findings = [];

  cards.forEach((card, order) => {
    if (card.username !== normalizedUsername) return;
    // Rank among real results, assigned by classifyCards after filtering out the
    // cards Fiverr injected. Array order is a fallback for older stored cards.
    const positionOnPage = Number.isInteger(card.position) ? card.position : order + 1;
    findings.push({
      sortMode: ctx.sortMode,
      page: ctx.page,
      positionOnPage,
      absolutePosition: ctx.positionOffset + positionOnPage,
      gigTitle: card.title || '(untitled gig)',
      gigUrl: card.url,
      gigKey: `${card.username}/${card.slug}`,
      capturedAt: Date.now(),
    });
  });

  return findings;
}

/** Collapse findings into one summary line per sort mode, for the UI and history. */
export function summarizeBySortMode(scan) {
  const summary = {};
  for (const modeId of scan.sortModes) {
    const found = scan.findings.filter((f) => f.sortMode === modeId);
    summary[modeId] = {
      sortMode: modeId,
      found: found.length > 0,
      pagesScanned: scan.progress?.[modeId]?.pagesScanned ?? 0,
      exhausted: scan.progress?.[modeId]?.exhausted ?? false,
      best: found.length
        ? found.reduce((a, b) => (a.absolutePosition <= b.absolutePosition ? a : b))
        : null,
      all: found,
    };
  }
  return summary;
}
