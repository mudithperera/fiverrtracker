/**
 * Client for the backend that owns identity, billing and quota.
 *
 * The extension renders entitlements; it never decides them. Anything gated in
 * here is gated for presentation only — the server re-checks every call, because
 * chrome.storage is user-writable and a client-side quota is decoration.
 */

export const API_BASE_KEY = 'apiBase';
export const SESSION_KEY = 'session';

/** Overridable from storage so a dev build can point at localhost. */
export const DEFAULT_API_BASE = 'https://api.rankpeek.app';

const REQUEST_TIMEOUT_MS = 15000;

export async function getApiBase() {
  const stored = (await chrome.storage.local.get(API_BASE_KEY))[API_BASE_KEY];
  return (stored || DEFAULT_API_BASE).replace(/\/$/, '');
}

export async function getSession() {
  return (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] || null;
}

export async function setSession(session) {
  if (session) await chrome.storage.local.set({ [SESSION_KEY]: session });
  else await chrome.storage.local.remove(SESSION_KEY);
}

export async function isSignedIn() {
  return Boolean((await getSession())?.token);
}

/** Thrown for any non-2xx so callers can distinguish "signed out" from "offline". */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.signedOut = status === 401;
  }
}

export async function apiFetch(path, { method = 'GET', body, auth = true } = {}) {
  const base = await getApiBase();
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';

  if (auth) {
    const session = await getSession();
    if (!session?.token) throw new ApiError('Not signed in.', 401);
    headers.authorization = `Bearer ${session.token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ApiError(
      error.name === 'AbortError' ? 'The server took too long to respond.' : 'Could not reach the server.',
      0,
    );
  } finally {
    clearTimeout(timer);
  }

  // A rejected token is worthless; drop it so the UI shows a sign-in prompt
  // instead of failing every call from here on.
  if (response.status === 401) {
    await setSession(null);
    throw new ApiError('Your session expired — sign in again.', 401);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error || `Request failed (${response.status}).`, response.status);
  }
  return payload;
}

// --- endpoints ---------------------------------------------------------------

/** Public: the picker must render before anyone signs in. */
export const fetchPlans = () => apiFetch('/plans', { auth: false });

export const fetchAccount = () => apiFetch('/me');
export const fetchScanPermission = () => apiFetch('/scans/permission');
export const reportScanComplete = () => apiFetch('/scans/complete', { method: 'POST' });

export const startCheckout = (plan, interval) =>
  apiFetch('/billing/checkout', { method: 'POST', body: { plan, interval } });

export const openBillingPortal = () => apiFetch('/billing/portal', { method: 'POST' });

/** Irreversible. The panel confirms before calling this. */
export const deleteAccount = () => apiFetch('/account/delete', { method: 'POST' });

// --- sign-in -----------------------------------------------------------------

/**
 * Google sign-in via chrome.identity.launchWebAuthFlow.
 *
 * Not getAuthToken: that only works for the Google account already signed into
 * Chrome and ties the product to Chrome. This flow hands off to our own backend,
 * which does the code exchange, so the extension never handles a Google token —
 * only our session JWT, returned in the redirect fragment.
 */
export async function signIn() {
  const base = await getApiBase();
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = `${base}/auth/google/start?redirect=${encodeURIComponent(redirectUri)}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!responseUrl) throw new Error('Sign-in was cancelled.');

  const fragment = new URL(responseUrl).hash.replace(/^#/, '');
  const params = new URLSearchParams(fragment);
  const error = params.get('error');
  if (error) throw new Error(`Sign-in failed (${error}).`);

  const token = params.get('token');
  if (!token) throw new Error('Sign-in did not return a session.');

  await setSession({ token, signedInAt: Date.now() });
  return fetchAccount();
}

export async function signOut() {
  await setSession(null);
}
