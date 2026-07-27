/**
 * Mint a proxy token from the command line.
 *
 * The gateway is the riskiest untested part of the system — a socket relay that
 * unit tests can only cover so far. Verifying it normally means Google OAuth,
 * Stripe, DNS and a deploy, which is an absurd amount of setup to discover a bug
 * in a pipe. This prints a token directly so the relay can be exercised with curl
 * before any of that exists.
 *
 *   node src/proxy/mint.js --country nz
 *
 * Requires only JWT_SECRET, and mints for a fake user id, so it proves the
 * transport rather than the entitlement check — which is exactly the part unit
 * tests already cover.
 */

import { mintProxyToken } from './token.js';

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const country = valueOf('--country', 'nz');
const userId = valueOf('--user', '00000000-0000-0000-0000-000000000000');
const secret = process.env.JWT_SECRET;

if (!secret) {
  console.error('JWT_SECRET is not set. It must match the one the gateway runs with.');
  process.exit(1);
}

const token = await mintProxyToken({ jwtSecret: secret }, { userId, country });
const host = process.env.PROXY_GATEWAY_HOST || 'localhost';
const port = process.env.PROXY_GATEWAY_PORT || '8443';

console.log(token);
console.error(`
Test the relay with it:

  curl -sS -x http://${token}:x@${host}:${port} https://www.fiverr.com/ -o /dev/null -w '%{http_code}\\n'

A 200 means the whole chain works: token accepted, upstream dialled, tunnel open.

  curl -sS -x http://${token}:x@${host}:${port} https://example.com/ -o /dev/null -w '%{http_code}\\n'

That one must fail — the gateway only speaks to Fiverr, and if it does not, you
are running an open proxy.
`);
