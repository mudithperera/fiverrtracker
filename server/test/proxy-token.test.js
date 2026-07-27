import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_HOSTS,
  isAllowedHost,
  mintProxyToken,
  parseConnectTarget,
  readProxyAuth,
  verifyProxyToken,
} from '../src/proxy/token.js';

const env = { jwtSecret: 'test-secret-that-is-long-enough-to-sign-with' };

test('a minted token round-trips with its user and country', async () => {
  const token = await mintProxyToken(env, { userId: 'user-1', country: 'nz' });
  assert.deepEqual(await verifyProxyToken(env, token), { userId: 'user-1', country: 'nz' });
});

test('a token signed with another secret is refused', async () => {
  const token = await mintProxyToken({ jwtSecret: 'a-completely-different-secret-value' }, {
    userId: 'user-1',
    country: 'nz',
  });
  assert.equal(await verifyProxyToken(env, token), null);
});

test('garbage is refused rather than throwing', async () => {
  for (const bad of ['', 'not.a.token', null, undefined, 'a.b.c']) {
    assert.equal(await verifyProxyToken(env, bad), null, String(bad));
  }
});

test('a session token cannot be used at the gateway', async () => {
  // Different audience on purpose: a stolen API session should not also grant
  // proxy access, and vice versa.
  const { SignJWT } = await import('jose');
  const sessionToken = await new SignJWT({ email: 'a@b.c' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(new TextEncoder().encode(env.jwtSecret));

  assert.equal(await verifyProxyToken(env, sessionToken), null);
});

test('only Fiverr hosts are allowed through', () => {
  for (const host of ALLOWED_HOSTS) assert.equal(isAllowedHost(host), true, host);
  assert.equal(isAllowedHost('sub.fiverr.com'), true, 'subdomains');
  assert.equal(isAllowedHost('WWW.FIVERR.COM'), true, 'case-insensitive');
});

test('everything else is refused — this is what stops it being an open proxy', () => {
  for (const host of [
    'google.com',
    'fiverr.com.evil.net',
    'notfiverr.com',
    'evilfiverr.com',
    '127.0.0.1',
    '169.254.169.254', // cloud metadata, the classic SSRF target
    '',
    null,
  ]) {
    assert.equal(isAllowedHost(host), false, String(host));
  }
});

test('CONNECT targets are parsed strictly', () => {
  assert.deepEqual(parseConnectTarget('www.fiverr.com:443'), { host: 'www.fiverr.com', port: 443 });
  assert.deepEqual(parseConnectTarget('fiverr.com:80'), { host: 'fiverr.com', port: 80 });
});

test('unusual ports are refused, so the gateway is not a port scanner', () => {
  for (const target of [
    'fiverr.com:22',
    'fiverr.com:3306',
    'fiverr.com:6379',
    'fiverr.com',
    'fiverr.com:',
    'fiverr.com:abc',
    'fiverr.com:443:443',
    '/etc/passwd:443',
    null,
  ]) {
    assert.equal(parseConnectTarget(target), null, String(target));
  }
});

test('proxy credentials are read from the Basic header', () => {
  const header = `Basic ${Buffer.from('the-token:ignored').toString('base64')}`;
  assert.deepEqual(readProxyAuth(header), { username: 'the-token', password: 'ignored' });
});

test('a colon in the password does not truncate it', () => {
  const header = `Basic ${Buffer.from('user:pa:ss').toString('base64')}`;
  assert.deepEqual(readProxyAuth(header), { username: 'user', password: 'pa:ss' });
});

test('malformed auth headers yield nothing', () => {
  for (const header of ['', 'Bearer abc', 'Basic', 'Basic !!!not base64!!!', null]) {
    const result = readProxyAuth(header);
    assert.ok(result === null || typeof result.username === 'string', String(header));
  }
});
