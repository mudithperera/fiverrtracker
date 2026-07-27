/**
 * Short-lived credentials for the proxy gateway.
 *
 * Customers must never hold the real proxy credentials. An extension's storage is
 * readable from DevTools by the person running it, so anything shipped to the
 * client is public — and a leaked residential proxy login is someone else's bill
 * and, eventually, someone else's abuse complaint.
 *
 * Instead the API mints a signed token naming the user and the country. The
 * gateway verifies it, then dials the upstream proxy with credentials that never
 * leave the server.
 *
 * Tokens are stateless and short-lived rather than stored and revocable: a scan
 * lasts a minute or two, so fifteen minutes is generous, and the alternative is a
 * database round trip on every CONNECT.
 */

import { SignJWT, jwtVerify } from 'jose';

export const TOKEN_TTL_SECONDS = 15 * 60;

/** Hosts the gateway will connect to. Anything else is refused. */
export const ALLOWED_HOSTS = ['fiverr.com', 'www.fiverr.com'];

const secretFor = (env) => new TextEncoder().encode(env.jwtSecret);

export async function mintProxyToken(env, { userId, country }) {
  return new SignJWT({ country })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    // Distinct audience so a session token cannot be presented to the gateway,
    // nor a proxy token to the API.
    .setAudience('proxy')
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(secretFor(env));
}

export async function verifyProxyToken(env, token) {
  try {
    const { payload } = await jwtVerify(token, secretFor(env), { audience: 'proxy' });
    if (!payload.sub || !payload.country) return null;
    return { userId: payload.sub, country: String(payload.country).toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Whether the gateway may connect to a host.
 *
 * This is the difference between a product feature and an open proxy. Without it
 * anyone holding a token could relay arbitrary traffic through the server, and
 * open proxies are found and abused within hours.
 */
export function isAllowedHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const name = host.toLowerCase().split(':')[0];
  return ALLOWED_HOSTS.some((allowed) => name === allowed || name.endsWith(`.${allowed}`));
}

/** Split a CONNECT target into host and port, rejecting anything malformed. */
export function parseConnectTarget(target) {
  if (typeof target !== 'string') return null;
  const match = target.match(/^([^:/]+):(\d{1,5})$/);
  if (!match) return null;
  const port = Number(match[2]);
  // Only ordinary web ports: a gateway that will dial any port is a port scanner
  // for whoever holds a token.
  if (port !== 443 && port !== 80) return null;
  return { host: match[1].toLowerCase(), port };
}

/** Pull the credentials out of a Proxy-Authorization header. */
export function readProxyAuth(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}
