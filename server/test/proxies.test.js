import test from 'node:test';
import assert from 'node:assert/strict';

import {
  configuredCountries,
  countryEnvKey,
  parseProxy,
  proxyForCountry,
} from '../src/worker/proxies.js';

test('parses the host:port:user:pass form dashboards print', () => {
  assert.deepEqual(parseProxy('51.194.203.99:43118:someuser:somepass'), {
    server: 'http://51.194.203.99:43118',
    username: 'someuser',
    password: 'somepass',
  });
});

test('parses the user:pass@host:port form', () => {
  assert.deepEqual(parseProxy('someuser:somepass@51.194.203.99:43118'), {
    server: 'http://51.194.203.99:43118',
    username: 'someuser',
    password: 'somepass',
  });
});

test('parses a full URL, including escaped credentials', () => {
  assert.deepEqual(parseProxy('http://someuser:p%40ss@51.194.203.99:43118'), {
    server: 'http://51.194.203.99:43118',
    username: 'someuser',
    password: 'p@ss',
  });
});

test('a colon in the password survives', () => {
  // Splitting naively on every colon would silently truncate the password and
  // produce an authentication failure that looks like a block.
  assert.deepEqual(parseProxy('1.2.3.4:8000:user:pa:ss:word'), {
    server: 'http://1.2.3.4:8000',
    username: 'user',
    password: 'pa:ss:word',
  });
});

test('an @ inside the password does not confuse the host split', () => {
  assert.deepEqual(parseProxy('user:p@ss@1.2.3.4:8000'), {
    server: 'http://1.2.3.4:8000',
    username: 'user',
    password: 'p@ss',
  });
});

test('accepts an endpoint with no credentials', () => {
  assert.deepEqual(parseProxy('1.2.3.4:8000'), { server: 'http://1.2.3.4:8000' });
});

test('rejects nonsense rather than producing a broken endpoint', () => {
  for (const bad of ['', '   ', 'not-a-proxy', null, undefined, 42, 'host:']) {
    assert.equal(parseProxy(bad), null, String(bad));
  }
});

test('country keys are normalised', () => {
  assert.equal(countryEnvKey('us'), 'PROXY_US');
  assert.equal(countryEnvKey('GB'), 'PROXY_GB');
  assert.equal(countryEnvKey(undefined), 'PROXY_DEFAULT');
});

test('a dedicated country endpoint wins over the default', () => {
  const env = {
    PROXY_US: '1.1.1.1:8000:us_user:pass',
    PROXY_DEFAULT: '9.9.9.9:8000:any_user:pass',
  };
  const picked = proxyForCountry('us', env);
  assert.equal(picked.proxy.server, 'http://1.1.1.1:8000');
  assert.equal(picked.usedFallback, false);
});

test('an unconfigured country falls back but says so', () => {
  // A scan that quietly ran from the wrong country would be stored as that
  // country's ranking and be wrong in a way nobody could see.
  const env = { PROXY_DEFAULT: '9.9.9.9:8000:any_user:pass' };
  const picked = proxyForCountry('nz', env);
  assert.equal(picked.proxy.server, 'http://9.9.9.9:8000');
  assert.equal(picked.usedFallback, true);
});

test('no configuration at all yields no proxy', () => {
  const picked = proxyForCountry('us', {});
  assert.equal(picked.proxy, null);
  assert.equal(picked.usedFallback, false);
});

test('the legacy username-template form still works', () => {
  const env = {
    PROXY_HOST: 'rotating.example.com',
    PROXY_PORT: '9000',
    PROXY_USERNAME_TEMPLATE: 'acct-country-{country}',
    PROXY_PASSWORD: 'pw',
  };
  const picked = proxyForCountry('gb', env);
  assert.equal(picked.proxy.server, 'http://rotating.example.com:9000');
  assert.equal(picked.proxy.username, 'acct-country-gb');
});

test('configuredCountries lists only usable endpoints', () => {
  const env = {
    PROXY_US: '1.1.1.1:8000:u:p',
    PROXY_GB: '2.2.2.2:8000:u:p',
    PROXY_NZ: 'garbage',
    PROXY_DEFAULT: '9.9.9.9:8000:u:p',
    PROXY_HOST: 'ignored.example.com',
  };
  assert.deepEqual(configuredCountries(env), ['gb', 'us']);
});
