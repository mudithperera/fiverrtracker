/**
 * Fiverr search page agent.
 *
 * Runs as a classic content script (no ES imports). It is deliberately a *dumb
 * scraper*: it hands raw anchors back to the background worker, which owns the
 * "is this a gig link / does this handle match" logic in src/lib/extract.js. That
 * keeps the URL rules in one testable place instead of duplicated across contexts.
 *
 * Fiverr's class names are hashed and change without notice, so nothing here
 * selects on them.
 */

(() => {
  if (window.__fiverrRankTrackerInstalled) return;
  window.__fiverrRankTrackerInstalled = true;

  const CARD_WAIT_TIMEOUT_MS = 12000;
  const CARD_SETTLE_MS = 350;
  const SORT_CLICK_URL_TIMEOUT_MS = 6000;

  /**
   * Readiness heuristic only — "do gig-shaped links exist yet". The authoritative
   * parse happens in the background via parseGigPath().
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

  /** Resolve once gig links appear, or on timeout so the caller can decide. */
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

  function anchorTitle(anchor) {
    const own = (anchor.textContent || '').trim().replace(/\s+/g, ' ');
    if (own) return own.slice(0, 200);
    const img = anchor.querySelector('img[alt]');
    const alt = img?.getAttribute('alt')?.trim();
    if (alt) return alt.slice(0, 200);
    const aria = anchor.getAttribute('aria-label')?.trim();
    return aria ? aria.slice(0, 200) : '';
  }

  /** Every anchor on the page in DOM order; the background decides what's a gig. */
  function collectAnchors() {
    const anchors = [];
    document.querySelectorAll('a[href]').forEach((anchor) => {
      const pathname = pathnameOf(anchor);
      if (!pathname) return;
      let url;
      try {
        url = new URL(anchor.getAttribute('href'), location.origin);
        url.search = '';
        url.hash = '';
      } catch {
        return;
      }
      anchors.push({ pathname, url: url.toString(), title: anchorTitle(anchor) });
    });
    return anchors;
  }

  async function handleExtract() {
    if (detectBotCheck()) {
      return { ok: true, botCheck: true, anchors: [], noResults: false, url: location.href };
    }
    const { timedOut } = await waitForCards();
    // A bot wall can also appear during the wait.
    if (detectBotCheck()) {
      return { ok: true, botCheck: true, anchors: [], noResults: false, url: location.href };
    }
    const anchors = collectAnchors();
    return {
      ok: true,
      botCheck: false,
      noResults: detectNoResults(),
      timedOut,
      anchors,
      url: location.href,
      title: document.title,
    };
  }

  // --- Sort-mode calibration -------------------------------------------------
  // Fiverr's sort parameter is undocumented. We locate the sort control by its
  // visible label (supplied by the background from src/lib/sortmodes.js so the
  // patterns live in one place) and read or trigger it.

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
   * Report what the sort control looks like on this page. If the options are real
   * links we can read the parameters straight off the hrefs and skip clicking
   * entirely.
   */
  function handleDiscoverSort(modes) {
    const options = [];
    for (const mode of modes) {
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
      options.push({
        id: mode.id,
        found: Boolean(chosen),
        visible: Boolean(visible.length),
        href,
        text: chosen ? textOf(chosen) : null,
      });
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

    const target = () => findLabelElements(mode.pattern).filter(isVisible)[0] || null;

    let option = target();
    if (!option) {
      // Dropdown is probably collapsed; click whichever other sort label is showing
      // (the trigger displays the currently active sort) to open it.
      const trigger = modes
        .filter((m) => m.id !== mode.id)
        .flatMap((m) => findLabelElements(m.pattern).filter(isVisible))[0];
      if (!trigger) {
        return { ok: false, reason: 'sort-control-not-found', url: startUrl };
      }
      (trigger.closest('button, [role="button"], a') || trigger).click();
      await sleep(500);
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case 'PING':
        sendResponse({ ok: true, url: location.href });
        return false;
      case 'EXTRACT':
        handleExtract().then(sendResponse, (error) =>
          sendResponse({ ok: false, error: String(error) }),
        );
        return true;
      case 'DISCOVER_SORT':
        try {
          sendResponse(handleDiscoverSort(message.modes || []));
        } catch (error) {
          sendResponse({ ok: false, error: String(error) });
        }
        return false;
      case 'CLICK_SORT':
        handleClickSort(message).then(sendResponse, (error) =>
          sendResponse({ ok: false, error: String(error) }),
        );
        return true;
      default:
        return false;
    }
  });
})();
