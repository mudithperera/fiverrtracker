/**
 * The stealth patches, verified in a real browser.
 *
 * Asserting the strings would prove nothing — what matters is what a page script
 * actually observes, so these load a blank page with the init script applied and
 * read the properties back the way a detector would.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import {
  KNOWN_COUNTRIES,
  LAUNCH_ARGS,
  clientHintHeaders,
  localeFor,
  stealthInitScript,
  userAgentFrom,
} from '../src/worker/stealth.js';

test('userAgentFrom strips the Headless marker', () => {
  // "HeadlessChrome/141.0.0.0" in the user agent is a one-line giveaway.
  // Anchored on the whole string: a loose match happily accepted the malformed
  // "Chrome/Chrome/141.0.0.0" this used to produce.
  assert.equal(
    userAgentFrom('HeadlessChrome/141.0.7390.54'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/141.0.0.0 Safari/537.36',
  );
  // Playwright reports a bare version too, depending on the channel.
  assert.match(userAgentFrom('141.0.7390.54'), /Chrome\/141\.0\.0\.0 Safari/);
  assert.match(userAgentFrom(''), /Chrome\/\d+\.0\.0\.0 Safari/, 'falls back cleanly');
});

test('client hints agree with the user agent version', () => {
  // A user agent claiming 141 alongside hints claiming 120 is itself detectable.
  const hints = clientHintHeaders('HeadlessChrome/141.0.7390.54');
  assert.match(hints['sec-ch-ua'], /v="141"/);
  assert.equal(hints['sec-ch-ua-mobile'], '?0');
});

test('locale, timezone and languages are consistent per country', () => {
  const gb = localeFor('gb');
  assert.equal(gb.locale, 'en-GB');
  assert.equal(gb.timezoneId, 'Europe/London');
  assert.ok(gb.languages.includes('en-GB'));

  // Unknown countries must still produce a coherent identity, not undefined.
  const unknown = localeFor('zz');
  assert.equal(unknown.locale, 'en-US');
  assert.ok(unknown.timezoneId);
});

test('the patched page reports as a normal browser', async () => {
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  try {
    const { languages } = localeFor('us');
    const context = await browser.newContext({
      userAgent: userAgentFrom(browser.version()),
      locale: 'en-US',
    });
    await context.addInitScript(stealthInitScript({ languages }));
    const page = await context.newPage();
    await page.goto('about:blank');

    const seen = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      plugins: navigator.plugins.length,
      languages: [...navigator.languages],
      hasChrome: Boolean(window.chrome),
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory,
      ua: navigator.userAgent,
    }));

    assert.equal(seen.webdriver, undefined, 'navigator.webdriver is the first thing checked');
    assert.ok(seen.plugins > 0, 'an empty plugin array marks a headless browser');
    assert.deepEqual(seen.languages, languages);
    assert.equal(seen.hasChrome, true, 'real Chrome exposes window.chrome');
    assert.ok(seen.cores > 0, 'zero cores is reported by no real device');
    assert.ok(seen.memory > 0);
    assert.doesNotMatch(seen.ua, /Headless/i);
  } finally {
    await browser.close();
  }
});

test('the notification permission inconsistency is closed', async () => {
  // Headless reports permission 'denied' while the permissions API says
  // 'default'. The mismatch is a standard detection.
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext();
    await context.addInitScript(stealthInitScript({ languages: ['en-US', 'en'] }));
    const page = await context.newPage();
    await page.goto('about:blank');

    const consistent = await page.evaluate(async () => {
      const status = await navigator.permissions.query({ name: 'notifications' });
      return status.state === Notification.permission;
    });
    assert.equal(consistent, true);
  } finally {
    await browser.close();
  }
});

test('every configured country gets a coherent identity', () => {
  // A New Zealand exit IP reporting America/New_York is the contradiction these
  // systems look for — and it is what the fallback silently produced before nz
  // was added.
  for (const country of KNOWN_COUNTRIES) {
    const { locale, timezoneId, languages } = localeFor(country);
    assert.ok(locale && timezoneId && languages?.length, country);
    assert.notEqual(
      timezoneId,
      country === 'us' ? null : 'America/New_York',
      `${country} silently fell back to the US identity`,
    );
  }
});

test('nz maps to New Zealand, not the fallback', () => {
  assert.deepEqual(localeFor('nz'), {
    locale: 'en-NZ',
    timezoneId: 'Pacific/Auckland',
    languages: ['en-NZ', 'en'],
  });
  assert.deepEqual(localeFor('NZ'), localeFor('nz'), 'case does not matter');
});
