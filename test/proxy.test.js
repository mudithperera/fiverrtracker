import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROXIED_HOSTS,
  buildPacScript,
  countryChoiceState,
  countryName,
  parseProxyEntry,
  proxySettingsForSession,
  resolveCountryChoice,
} from '../src/lib/proxy.js';

const NZ = '51.194.203.99:43118:someuser:somepass';

test('parses the notations proxy dashboards print', () => {
  const expected = { host: '51.194.203.99', port: 43118, username: 'someuser', password: 'somepass' };
  assert.deepEqual(parseProxyEntry(NZ), expected);
  assert.deepEqual(parseProxyEntry('someuser:somepass@51.194.203.99:43118'), expected);
  assert.deepEqual(parseProxyEntry('http://someuser:somepass@51.194.203.99:43118'), expected);
});

test('a colon in the password survives', () => {
  // Splitting on every colon would truncate it, and a truncated password fails
  // authentication in a way that looks exactly like the proxy being blocked.
  assert.deepEqual(parseProxyEntry('1.2.3.4:8000:user:pa:ss'), {
    host: '1.2.3.4',
    port: 8000,
    username: 'user',
    password: 'pa:ss',
  });
});

test('rejects anything that would produce a broken endpoint', () => {
  for (const bad of ['', '   ', 'nonsense', '1.2.3.4', '1.2.3.4:abc', '1.2.3.4:99999', null, 7]) {
    assert.equal(parseProxyEntry(bad), null, String(bad));
  }
});

test('the PAC script routes Fiverr through the proxy', () => {
  const pac = buildPacScript({ host: '1.2.3.4', port: 8000 });
  const FindProxyForURL = new Function(`${pac}; return FindProxyForURL;`)();

  for (const host of PROXIED_HOSTS) {
    assert.equal(FindProxyForURL(`https://${host}/`, host), 'PROXY 1.2.3.4:8000', host);
  }
  assert.equal(
    FindProxyForURL('https://sub.fiverr.com/x', 'sub.fiverr.com'),
    'PROXY 1.2.3.4:8000',
    'subdomains too',
  );
});

test('everything else stays direct', () => {
  // The whole justification for a PAC script rather than a blanket proxy setting:
  // nobody's banking session should be routed through a third party.
  const pac = buildPacScript({ host: '1.2.3.4', port: 8000 });
  const FindProxyForURL = new Function(`${pac}; return FindProxyForURL;`)();

  for (const host of ['google.com', 'bank.example.com', 'notfiverr.com', 'fiverr.com.evil.net']) {
    assert.equal(FindProxyForURL(`https://${host}/`, host), 'DIRECT', host);
  }
});

test('host matching is case-insensitive', () => {
  const pac = buildPacScript({ host: '1.2.3.4', port: 8000 });
  const FindProxyForURL = new Function(`${pac}; return FindProxyForURL;`)();
  assert.equal(FindProxyForURL('https://WWW.FIVERR.COM/', 'WWW.FIVERR.COM'), 'PROXY 1.2.3.4:8000');
});

test('a gateway session becomes a chrome.proxy config', () => {
  // The session names our gateway, never the upstream proxy: anything sent to the
  // extension is readable by whoever is running it.
  const settings = proxySettingsForSession({
    host: 'gateway.rankpeek.app',
    port: 8443,
    username: 'a.signed.token',
    password: 'x',
  });
  assert.equal(settings.mode, 'pac_script');
  assert.match(settings.pacScript.data, /gateway\.rankpeek\.app:8443/);
  assert.equal(settings.pacScript.mandatory, true, 'never silently fall back to direct');
  assert.doesNotMatch(
    settings.pacScript.data,
    /a\.signed\.token/,
    'the token belongs in the auth header, not the PAC script',
  );
});

test('an incomplete session yields no settings rather than a broken one', () => {
  for (const bad of [null, undefined, {}, { host: 'x' }, { port: 8443 }]) {
    assert.equal(proxySettingsForSession(bad), null, JSON.stringify(bad));
  }
});

test('country names are human-readable', () => {
  assert.equal(countryName('nz'), 'New Zealand');
  assert.equal(countryName('default'), 'My location');
  assert.equal(countryName('zz'), 'ZZ', 'unknown codes still render');
});

// --- picker states -----------------------------------------------------------

const PAID = { configured: ['de', 'us'], unlocked: true };
const FREE = { configured: ['de', 'us'], unlocked: false };

test('my location is always selectable, on any plan', () => {
  for (const gate of [PAID, FREE, { configured: [], unlocked: false }]) {
    const state = countryChoiceState('default', gate);
    assert.equal(state.selectable, true);
    assert.equal(state.locked, false);
    assert.equal(state.suffix, '', 'the free default needs no badge');
  }
});

test('a country we have no proxy for is inert rather than sold', () => {
  const state = countryChoiceState('fr', PAID);
  assert.equal(state.selectable, false, 'nobody can scan it, so nobody may pick it');
  assert.equal(state.locked, false, 'not a paywall — we simply cannot do it');
  assert.equal(state.suffix, 'coming soon');
});

test('a configured country stays selectable when locked, so it can make its case', () => {
  const state = countryChoiceState('de', FREE);
  assert.equal(state.selectable, true, 'a greyed-out row cannot sell anything');
  assert.equal(state.locked, true);
  assert.equal(state.suffix, 'Business plan');
});

test('a configured country on the right plan is plain and unlabelled', () => {
  const state = countryChoiceState('de', PAID);
  assert.deepEqual(state, { selectable: true, locked: false, available: true, suffix: '' });
});

test('selectable never means scannable', () => {
  // The whole safety argument for showing locked countries rests on this: the
  // picker allows it, and every layer after the picker still refuses.
  assert.equal(countryChoiceState('de', FREE).selectable, true);
  assert.equal(countryChoiceState('de', FREE).locked, true);
});

test('a locked choice is kept rather than snapped back to my location', () => {
  assert.equal(resolveCountryChoice('de', FREE), 'de', 'losing the intent loses the sale');
});

test('an unscannable choice falls back to my location', () => {
  assert.equal(resolveCountryChoice('fr', PAID), 'default');
  assert.equal(resolveCountryChoice('zz', PAID), 'default');
});

test('the choice survives the moment before the country list has loaded', () => {
  // /proxy/countries is a round trip; until it answers, `configured` is empty.
  // Falling back to 'default' here would quietly discard a saved preference.
  const loading = { configured: [], unlocked: true };
  assert.equal(resolveCountryChoice('de', loading), 'default');
  assert.equal(resolveCountryChoice('de', PAID), 'de', 'and comes back once it lands');
});

test('country codes are normalised before they are judged', () => {
  assert.equal(resolveCountryChoice('DE', FREE), 'de');
  assert.equal(resolveCountryChoice(null, FREE), 'default');
});
