/**
 * Google sign-in for a Chrome extension, and the session tokens it issues.
 *
 * The extension calls chrome.identity.launchWebAuthFlow — not getAuthToken —
 * because getAuthToken only works for the Google account already signed into
 * Chrome and locks the product to Chrome. launchWebAuthFlow opens *our* OAuth
 * start URL and waits for a redirect back to https://<extension-id>.chromiumapp.org/,
 * which means the same flow works in Edge or Firefox later.
 *
 * The extension never sees the Google client secret or an access token: the code
 * exchange happens here, and the extension receives only our own session JWT.
 */

import { SignJWT, jwtVerify } from 'jose';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const OAUTH_SCOPES = ['openid', 'email', 'profile'];

/** Where Google sends the browser back to. Must match the console exactly. */
export function redirectUri(env) {
  return `${env.publicUrl}/auth/google/callback`;
}

/**
 * The extension's own callback, e.g. https://<id>.chromiumapp.org/.
 * Checked against an allow-list so this backend cannot be used to sign users into
 * somebody else's extension.
 */
export function isAllowedExtensionRedirect(env, target) {
  if (!target) return false;
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const match = url.hostname.match(/^([a-p]{32})\.chromiumapp\.org$/);
  if (!match) return false;
  // An empty allow-list means "development": accept any well-formed extension id.
  if (!env.allowedExtensionIds.length) return true;
  return env.allowedExtensionIds.includes(match[1]);
}

export function buildGoogleAuthUrl(env, state) {
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', env.google.clientId);
  url.searchParams.set('redirect_uri', redirectUri(env));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', state);
  // Consent screens are annoying, but without them a user who revokes access can
  // never re-grant it.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeCodeForProfile(env, code) {
  const response = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: redirectUri(env),
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${await response.text()}`);
  }

  const { access_token: accessToken } = await response.json();
  const profileResponse = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok) {
    throw new Error(`Google userinfo failed: ${profileResponse.status}`);
  }

  const profile = await profileResponse.json();
  if (!profile.sub || !profile.email) throw new Error('Google profile missing sub or email');
  if (profile.email_verified === false) throw new Error('Google email is not verified');
  return profile;
}

// --- session tokens ----------------------------------------------------------

const secretFor = (env) => new TextEncoder().encode(env.jwtSecret);

export async function issueSession(env, user) {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${env.sessionDays}d`)
    .sign(secretFor(env));
}

export async function verifySession(env, token) {
  try {
    const { payload } = await jwtVerify(token, secretFor(env));
    return payload.sub ? { userId: payload.sub, email: payload.email } : null;
  } catch {
    return null;
  }
}

/**
 * Signed, short-lived state so the callback can trust which extension asked for
 * the sign-in. Rolling this into a JWT avoids needing server-side session storage
 * for a flow that lasts about fifteen seconds.
 */
export async function signState(env, extensionRedirect) {
  return new SignJWT({ r: extensionRedirect })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(secretFor(env));
}

export async function readState(env, state) {
  try {
    const { payload } = await jwtVerify(state, secretFor(env));
    return typeof payload.r === 'string' ? payload.r : null;
  } catch {
    return null;
  }
}

/** Hono middleware: require a valid session, attach { userId } to the context. */
export function requireAuth(env) {
  return async (c, next) => {
    const header = c.req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const session = token ? await verifySession(env, token) : null;
    if (!session) return c.json({ error: 'Not signed in.' }, 401);
    c.set('session', session);
    await next();
  };
}
