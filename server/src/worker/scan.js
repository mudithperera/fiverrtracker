/**
 * Scans one keyword on Fiverr with a headless browser.
 *
 * The classification is *not* reimplemented here — `classifyCards` and
 * `buildSearchUrl` are imported from the extension's own libraries, so a rank
 * recorded by the nightly worker and a rank shown in the panel come from the same
 * code. Only the DOM sweep is duplicated, and a test pins the two together.
 *
 * Unproven assumption, deliberately isolated in this file: that Fiverr serves a
 * real results page to a headless browser at all. It fronts with PerimeterX and
 * returns 403 to plain HTTP clients. If it walls this too, `status: 'blocked'` is
 * the answer and residential proxies become mandatory rather than an upgrade.
 */

import { chromium } from 'playwright';
import { classifyCards } from '../../../src/lib/cards.js';
import { buildSearchUrl, fallbackCalibration } from '../../../src/lib/sortmodes.js';
import { pageSignature } from '../../../src/lib/extract.js';
import { collectCardsInPage, readPageStateInPage } from './collect.js';
import {
  LAUNCH_ARGS,
  clientHintHeaders,
  localeFor,
  stealthInitScript,
  userAgentFrom,
} from './stealth.js';

/**
 * Blocked resource types. A Fiverr search page is 2–4MB with images and fonts and
 * about 400KB without — and none of it is needed, because everything we read comes
 * from `data-gig-id` attributes and hrefs. This is a 5–8× cut in residential proxy
 * bandwidth, which is the only per-scan cost that matters.
 */
const BLOCKED_RESOURCES = new Set(['image', 'font', 'media', 'stylesheet']);

const PAGE_TIMEOUT_MS = 45000;
const CARD_WAIT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function proxyFromEnv(env = process.env, country) {
  if (!env.PROXY_HOST) return undefined;
  // proxy-cheap and most residential providers encode the country in the username
  // rather than the host, and the exact shape varies by plan — so it is a template
  // rather than something guessed here.
  const template = env.PROXY_USERNAME_TEMPLATE || env.PROXY_USERNAME || '';
  const username = template
    .replace('{country}', country || 'any')
    .replace('{session}', Math.random().toString(36).slice(2, 10));

  return {
    server: `http://${env.PROXY_HOST}:${env.PROXY_PORT || 8080}`,
    username: username || undefined,
    password: env.PROXY_PASSWORD || undefined,
  };
}

/**
 * @returns {Promise<{status:'ok'|'blocked'|'empty'|'error', results?: Array,
 *                    pagesScanned:number, error?:string, diagnostics?:object}>}
 */
export async function scanKeyword({
  keyword,
  sortMode = 'relevance',
  country = 'default',
  maxPages = 3,
  delayMs = 2500,
  proxy,
  headless = true,
  /**
   * Injectable so the scan loop can be tested against a local fixture. Production
   * never passes it; there is no environment switch to get wrong.
   */
  urlFor,
  /** Tunable so tests do not sit through the full hydration wait on empty pages. */
  cardWaitMs = CARD_WAIT_MS,
} = {}) {
  const calibration = fallbackCalibration();
  const buildUrl =
    urlFor || ((page) => buildSearchUrl(keyword, page, sortMode, calibration));
  const results = [];
  const diagnostics = { pages: [] };
  let pagesScanned = 0;
  let browser;

  try {
    browser = await chromium.launch({ headless, proxy, args: LAUNCH_ARGS });

    // Derived from the browser's own version so the user agent, the Client Hints
    // headers and the engine all tell the same story. A borrowed version string
    // that disagrees with the engine is its own fingerprint.
    const version = browser.version();
    const { locale, timezoneId, languages } = localeFor(country);

    const context = await browser.newContext({
      userAgent: userAgentFrom(version),
      extraHTTPHeaders: { ...clientHintHeaders(version), 'accept-language': languages.join(',') },
      viewport: { width: 1440, height: 900 },
      locale,
      // Must match the exit IP: a US address reporting Asia/Colombo is a
      // contradiction anti-bot vendors specifically look for.
      timezoneId,
    });

    await context.addInitScript(stealthInitScript({ languages }));

    await context.route('**/*', (route) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);

    let previousSignature = null;

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      await page.goto(buildUrl(pageNumber), {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT_MS,
      });

      // Cards hydrate client-side; missing them is normal for a moment and fatal
      // only if they never arrive.
      await page
        .waitForSelector('[data-gig-id]', { timeout: cardWaitMs })
        .catch(() => null);

      const state = await page.evaluate(readPageStateInPage);
      if (state.botCheck) {
        return {
          status: 'blocked',
          pagesScanned,
          error: `Bot check on page ${pageNumber} (“${state.title}”)`,
          diagnostics,
        };
      }
      if (state.noResults && !state.cardCount) break;

      const raw = await page.evaluate(collectCardsInPage);
      const { organic, excluded, warnings } = classifyCards(raw, page.url());
      pagesScanned = pageNumber;
      diagnostics.pages.push({
        page: pageNumber,
        rawCards: raw.length,
        organic: organic.length,
        excluded,
        warnings,
      });

      if (!organic.length) break;

      // Fiverr clamps an out-of-range page back to the last real one, which would
      // otherwise record the same gigs on every remaining page.
      const signature = pageSignature(organic);
      if (signature && signature === previousSignature) break;
      previousSignature = signature;

      const offset = results.length;
      for (const card of organic) {
        results.push({
          position: offset + card.position,
          username: card.username,
          slug: card.slug,
          gigId: card.gigId,
          title: card.title,
        });
      }

      if (pageNumber < maxPages) await sleep(delayMs);
    }

    if (!results.length) return { status: 'empty', pagesScanned, diagnostics };
    return { status: 'ok', results, pagesScanned, diagnostics };
  } catch (error) {
    return { status: 'error', pagesScanned, error: String(error.message || error), diagnostics };
  } finally {
    await browser?.close().catch(() => {});
  }
}
