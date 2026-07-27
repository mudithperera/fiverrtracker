/**
 * Fiverr search page agent.
 *
 * Runs as a classic content script (no ES imports). It is deliberately a *dumb
 * scraper*: it reports the raw `[data-gig-id]` cards it can see and lets the
 * background worker decide which ones are real search results (src/lib/cards.js).
 * That keeps the classification rules in one testable place.
 *
 * It reads Fiverr's own `data-gig-id` attribute rather than inferring structure
 * from the DOM tree. Fiverr's class names are hashed and change without notice, so
 * nothing here selects on them.
 */

(() => {
  if (window.__fiverrRankTrackerInstalled) return;
  window.__fiverrRankTrackerInstalled = true;

  const CARD_WAIT_TIMEOUT_MS = 12000;
  const CARD_SETTLE_MS = 350;
  const SORT_CLICK_URL_TIMEOUT_MS = 6000;
  const DROPDOWN_OPEN_MS = 600;
  const HIGHLIGHT_KEY = 'pendingHighlight';
  const HIGHLIGHT_STYLE_ID = '__fiverrRankTrackerHighlight';

  /** Fiverr tags every result card with data-gig-id="<gigId>_<indexOnPage>". */
  const CARD_SELECTOR = '[data-gig-id]';

  /**
   * Readiness fallback only, for the case where Fiverr drops data-gig-id. The
   * authoritative parse happens in the background via parseGigPath().
   */
  const GIG_PATH_HINT = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?[a-z0-9_]{3,}\/[a-z0-9][a-z0-9-]{2,}/i;

  const NO_RESULTS_PATTERNS = [
    /no results found/i,
    /we couldn'?t find/i,
    /didn'?t match any/i,
    /try a different search/i,
    /0 services available/i,
  ];

  const BOT_CHECK_PATTERNS = [
    /just a moment/i,
    /checking your browser/i,
    /access denied/i,
    /unusual traffic/i,
    /verify you are human/i,
    /press and hold/i,
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function countGigHints() {
    const cards = document.querySelectorAll(CARD_SELECTOR).length;
    if (cards > 0) return cards;
    // data-gig-id missing entirely — fall back to link shapes so we don't block
    // forever on a page that has actually rendered.
    let count = 0;
    for (const anchor of document.querySelectorAll('a[href]')) {
      const path = pathnameOf(anchor);
      if (path && GIG_PATH_HINT.test(path)) count += 1;
    }
    return count;
  }

  function pathnameOf(anchor) {
    const href = anchor.getAttribute('href');
    if (!href) return null;
    try {
      return new URL(href, location.origin).pathname;
    } catch {
      return null;
    }
  }

  function detectBotCheck() {
    if (document.querySelector('#px-captcha, .px-captcha-container, [id*="px-captcha"]')) return true;
    if (document.querySelector('iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="challenge" i]')) {
      return true;
    }
    const title = document.title || '';
    if (BOT_CHECK_PATTERNS.some((re) => re.test(title))) return true;
    // Bot walls are tiny pages; don't scan a full search page's text for these.
    const bodyText = (document.body?.innerText || '').slice(0, 2000);
    if (bodyText.length < 1200 && BOT_CHECK_PATTERNS.some((re) => re.test(bodyText))) return true;
    return false;
  }

  function detectNoResults() {
    const bodyText = (document.body?.innerText || '').slice(0, 6000);
    return NO_RESULTS_PATTERNS.some((re) => re.test(bodyText));
  }

  /** Resolve once gig cards appear, or on timeout so the caller can decide. */
  function waitForCards() {
    return new Promise((resolve) => {
      if (countGigHints() > 0) {
        // Let late-hydrating cards land before we snapshot ordering.
        sleep(CARD_SETTLE_MS).then(() => resolve({ timedOut: false }));
        return;
      }
      let done = false;
      const finish = (timedOut) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        sleep(timedOut ? 0 : CARD_SETTLE_MS).then(() => resolve({ timedOut }));
      };
      const observer = new MutationObserver(() => {
        if (countGigHints() > 0) finish(false);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(true), CARD_WAIT_TIMEOUT_MS);
    });
  }

  /** Best available human-readable name for a gig card. */
  function cardTitle(wrapper, anchor) {
    const aria = anchor?.getAttribute('aria-label')?.trim();
    // Fiverr uses a generic "Go to gig" aria-label, which tells the user nothing.
    if (aria && !/^go to gig$/i.test(aria)) return aria.slice(0, 200);
    const img = wrapper.querySelector('img[alt]');
    const alt = img?.getAttribute('alt')?.trim();
    if (alt) return alt.slice(0, 200);
    const heading = wrapper.querySelector('h1, h2, h3, h4, p, [role="heading"]');
    const text = (heading?.textContent || '').trim().replace(/\s+/g, ' ');
    return text ? text.slice(0, 200) : '';
  }

  /** Pick the link that actually points at the gig, not the seller or a badge. */
  function gigAnchorIn(wrapper) {
    const anchors = Array.from(wrapper.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const path = pathnameOf(anchor);
      if (path && GIG_PATH_HINT.test(path)) return anchor;
    }
    return anchors[0] || null;
  }

  /**
   * Every card Fiverr tagged, in DOM order, with its raw id and link. The
   * background classifies these — see src/lib/cards.js.
   */
  function collectCards() {
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

  /**
   * Test seam. server/src/worker/collect.js has to duplicate collectCards() for
   * Playwright, and server/test/collect.test.js runs both against one fixture to
   * prove they agree. Content scripts run in an isolated world, so this is not
   * reachable from the page.
   */
  window.__frtCollectCards = collectCards;

  async function handleExtract(modes) {
    if (detectBotCheck()) {
      return { ok: true, botCheck: true, cards: [], noResults: false, url: location.href };
    }
    const { timedOut } = await waitForCards();
    // A bot wall can also appear during the wait.
    if (detectBotCheck()) {
      return { ok: true, botCheck: true, cards: [], noResults: false, url: location.href };
    }
    return {
      ok: true,
      botCheck: false,
      noResults: detectNoResults(),
      timedOut,
      cards: collectCards(),
      activeSort: detectActiveSort(modes),
      url: location.href,
      title: document.title,
    };
  }

  // --- Sort-mode calibration -------------------------------------------------
  // Fiverr's sort parameter is undocumented. We locate the sort control by its
  // visible label (supplied by the background from src/lib/sortmodes.js so the
  // patterns live in one place) and read or trigger it.
  //
  // The control is a collapsed button showing only the *current* sort, so the
  // other options do not exist in the DOM until it is opened.

  function textOf(el) {
    return (el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  /** Innermost elements whose visible text matches a sort label. */
  function findLabelElements(pattern) {
    const re = new RegExp(pattern, 'i');
    const matches = [];
    const candidates = document.querySelectorAll('a, button, li, span, div, option, [role="option"], [role="menuitem"]');
    for (const el of candidates) {
      const text = textOf(el);
      if (!text || text.length > 40) continue;
      if (!re.test(text)) continue;
      // Keep only the deepest element carrying this text.
      const deeper = Array.from(el.children).some((child) => re.test(textOf(child)));
      if (deeper) continue;
      matches.push(el);
    }
    return matches;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  /**
   * Which sort Fiverr is *actually* applying, read off its own control.
   *
   * While collapsed the control displays only the active sort, so the single
   * visible sort label is the answer. This is the check that catches a sort
   * parameter Fiverr silently ignores — the page keeps saying "Relevance" no
   * matter what we put in the URL, and without reading it back we would happily
   * report Relevance results as Best Selling.
   */
  function detectActiveSort(modes) {
    for (const mode of modes || []) {
      const match = findLabelElements(mode.pattern)
        .filter(isVisible)
        .find((el) => el.closest('button, select, [role="button"], [role="combobox"], [role="listbox"]'));
      if (match) return mode.id;
    }
    return null;
  }

  function describeOption(mode) {
    const elements = findLabelElements(mode.pattern);
    const visible = elements.filter(isVisible);
    const chosen = visible[0] || elements[0] || null;
    const anchor = chosen?.closest('a[href]') || null;
    let href = null;
    if (anchor) {
      try {
        href = new URL(anchor.getAttribute('href'), location.origin).toString();
      } catch {
        href = null;
      }
    }
    return {
      id: mode.id,
      found: Boolean(chosen),
      visible: Boolean(visible.length),
      href,
      text: chosen ? textOf(chosen) : null,
    };
  }

  /** Click whichever sort label is currently showing, to expand the dropdown. */
  async function openSortDropdown(modes) {
    const trigger = modes.flatMap((m) => findLabelElements(m.pattern).filter(isVisible))[0];
    if (!trigger) return false;
    (trigger.closest('button, [role="button"], [role="combobox"], a') || trigger).click();
    await sleep(DROPDOWN_OPEN_MS);
    return true;
  }

  /**
   * Report what the sort control looks like on this page. If the options are real
   * links we can read the parameters straight off the hrefs and skip clicking.
   *
   * Waits for the page to hydrate first: the control does not exist immediately
   * after navigation, and querying too early used to make calibration fail outright.
   */
  async function handleDiscoverSort(modes) {
    await waitForCards();

    let options = modes.map(describeOption);
    // Only the active sort is rendered while the dropdown is collapsed, so if any
    // option is missing, open it and look again before giving up.
    if (options.some((o) => !o.found)) {
      const opened = await openSortDropdown(modes);
      if (opened) {
        const reread = modes.map(describeOption);
        // Keep whichever pass found more; opening can also close an already-open menu.
        if (reread.filter((o) => o.found).length >= options.filter((o) => o.found).length) {
          options = reread;
        }
      }
    }

    return { ok: true, options, url: location.href };
  }

  /**
   * Open the sort dropdown and pick a mode. Returns the resulting URL when the
   * change is a client-side route swap; on a hard navigation this script dies and
   * the background reads the tab URL instead.
   */
  async function handleClickSort({ mode, modes }) {
    const startUrl = location.href;
    await waitForCards();

    const target = () => findLabelElements(mode.pattern).filter(isVisible)[0] || null;

    let option = target();
    if (!option) {
      // Dropdown is probably collapsed; the trigger displays the currently active
      // sort, so click whichever other sort label is showing to open it.
      const opened = await openSortDropdown(modes.filter((m) => m.id !== mode.id));
      if (!opened) return { ok: false, reason: 'sort-control-not-found', url: startUrl };
      option = target();
    }

    if (!option) return { ok: false, reason: 'sort-option-not-found', url: startUrl };

    (option.closest('a, button, li, [role="option"], [role="menuitem"]') || option).click();

    const deadline = Date.now() + SORT_CLICK_URL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (location.href !== startUrl) return { ok: true, url: location.href, startUrl };
      await sleep(150);
    }
    return { ok: false, reason: 'url-did-not-change', url: location.href, startUrl };
  }

  // --- Diagnostics -------------------------------------------------------------

  /**
   * Everything needed to work out why a scan went wrong, in one copyable blob.
   * This exists because diagnosing the last round of bugs took three rounds of
   * hand-written console snippets.
   */
  async function handleDiagnose(modes) {
    await waitForCards();
    const cards = collectCards();
    const sortControls = Array.from(
      document.querySelectorAll('button, select, [role="button"], [role="combobox"], [role="listbox"]'),
    )
      .map((el) => textOf(el))
      .filter((t) => t && t.length < 45);

    const contexts = {};
    for (const card of cards) {
      let url;
      try {
        url = new URL(card.href);
      } catch {
        continue;
      }
      const key = `${url.searchParams.get('context_referrer') || '-'} | ${url.searchParams.get('source') || '-'}`;
      contexts[key] = (contexts[key] || 0) + 1;
    }

    return {
      ok: true,
      url: location.href,
      title: document.title,
      cardCount: cards.length,
      gigIds: cards.map((c) => c.gigId).slice(0, 60),
      contexts,
      sortControls: Array.from(new Set(sortControls)).slice(0, 20),
      sortOptions: (modes || []).map(describeOption),
      botCheck: detectBotCheck(),
      noResults: detectNoResults(),
      sampleCards: cards.slice(0, 3),
      // Full list so the background can run the real classifier over it; it is
      // stripped back out before the report reaches the panel.
      cards,
    };
  }

  // --- Result highlighting -----------------------------------------------------
  // The panel can ask "show me this result on the page". The background navigates
  // here and leaves a request in storage; we pick it up once the page has loaded.

  function ensureHighlightStyle() {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
      .__frt-highlight {
        outline: 3px solid #1dbf73 !important;
        outline-offset: 4px !important;
        border-radius: 8px !important;
        scroll-margin-top: 120px;
        animation: __frt-pulse 1.2s ease-out 3;
      }
      @keyframes __frt-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(29, 191, 115, 0); }
        50% { box-shadow: 0 0 0 8px rgba(29, 191, 115, 0.25); }
      }
      .__frt-badge {
        position: absolute;
        z-index: 2147483647;
        background: #1dbf73;
        color: #fff;
        font: 600 12px/1.4 system-ui, sans-serif;
        padding: 4px 10px;
        border-radius: 999px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  function findCardByGigKey(gigKey) {
    if (!gigKey) return null;
    const needle = `/${gigKey.toLowerCase()}`;
    for (const wrapper of document.querySelectorAll(CARD_SELECTOR)) {
      for (const anchor of wrapper.querySelectorAll('a[href]')) {
        const path = (pathnameOf(anchor) || '').toLowerCase();
        if (path.includes(needle)) return wrapper;
      }
    }
    return null;
  }

  function highlightCard(wrapper, label) {
    ensureHighlightStyle();
    wrapper.classList.add('__frt-highlight');
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });

    if (label) {
      const badge = document.createElement('div');
      badge.className = '__frt-badge';
      badge.textContent = label;
      document.body.appendChild(badge);
      const place = () => {
        const rect = wrapper.getBoundingClientRect();
        badge.style.top = `${window.scrollY + rect.top - 14}px`;
        badge.style.left = `${window.scrollX + rect.left + 8}px`;
      };
      place();
      // Re-place after the smooth scroll settles.
      setTimeout(place, 700);
      setTimeout(() => badge.remove(), 12000);
    }
  }

  /** Consume a highlight request left by the background, if one is waiting for us. */
  async function applyPendingHighlight() {
    let pending;
    try {
      pending = (await chrome.storage.local.get(HIGHLIGHT_KEY))[HIGHLIGHT_KEY];
    } catch {
      return;
    }
    if (!pending || !pending.gigKey) return;
    if (pending.expiresAt && Date.now() > pending.expiresAt) {
      await chrome.storage.local.remove(HIGHLIGHT_KEY).catch(() => {});
      return;
    }

    await waitForCards();
    const wrapper = findCardByGigKey(pending.gigKey);
    if (!wrapper) return; // Leave it pending; the right page may still be loading.

    await chrome.storage.local.remove(HIGHLIGHT_KEY).catch(() => {});
    highlightCard(wrapper, pending.label || null);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case 'PING':
        sendResponse({ ok: true, url: location.href });
        return false;
      case 'EXTRACT':
        handleExtract(message.modes || []).then(sendResponse, (error) =>
          sendResponse({ ok: false, error: String(error) }),
        );
        return true;
      case 'DISCOVER_SORT':
        handleDiscoverSort(message.modes || []).then(sendResponse, (error) =>
          sendResponse({ ok: false, error: String(error) }),
        );
        return true;
      case 'CLICK_SORT':
        handleClickSort(message).then(sendResponse, (error) =>
          sendResponse({ ok: false, error: String(error) }),
        );
        return true;
      case 'DIAGNOSE':
        handleDiagnose(message.modes || []).then(sendResponse, (error) =>
          sendResponse({ ok: false, error: String(error) }),
        );
        return true;
      case 'HIGHLIGHT':
        applyPendingHighlight().then(
          () => sendResponse({ ok: true }),
          (error) => sendResponse({ ok: false, error: String(error) }),
        );
        return true;
      default:
        return false;
    }
  });

  applyPendingHighlight().catch(() => {});
})();
