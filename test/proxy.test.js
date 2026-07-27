import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROXIED_HOSTS,
  buildPacScript,
  countryName,
  parseProxyEntry,
  proxySettingsForSession,
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
