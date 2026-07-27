/**
 * Plan / quota gating, backed by the server.
 *
 * The authority is the API — `canStartScan` and `consumeCheck` are round trips,
 * and the server re-derives the quota from its own usage table. Nothing here is
 * enforcement; it renders what the server says and caches the last answer so the
 * panel has something to draw while offline.
 *
 * Signed-out users get a small local allowance so the extension is usable before
 * anyone creates an account. That allowance *is* trivially bypassable, which is
 * exactly why it is small and why every paid feature requires a session.
 */

import { ApiError, fetchAccount, fetchScanPermission, isSignedIn, reportScanComplete } from './api.js';

export const ENTITLEMENT_KEY = 'entitlement';
export const ANON_KEY = 'anonUsage';
/** Deliberately modest: it exists to let someone try the tool, not to be a plan. */
export const ANON_CHECK_LIMIT = 3;

export const PLAN = {
  FREE: 'free',
  PRO: 'pro',
  BUSINESS: 'business',
};

const startOfUtcDay = () => new Date().toISOString().slice(0, 10);

function anonEntitlement(used) {
  return {
    plan: PLAN.FREE,
    planLabel: 'Not signed in',
    signedIn: false,
    unlimited: false,
    limit: ANON_CHECK_LIMIT,
    checksUsed: used,
    checksRemaining: Math.max(0, ANON_CHECK_LIMIT - used),
    features: { trackedKeywords: 0, geoTracking: false, competitors: 0, exports: false },
    subscription: null,
  };
}

async function readAnonUsage() {
  const stored = (await chrome.storage.local.get(ANON_KEY))[ANON_KEY];
  // Usage is per UTC day, matching the server, so the two never disagree about
  // when "today" started.
  if (!stored || stored.day !== startOfUtcDay()) return 0;
  return stored.checks || 0;
}

async function bumpAnonUsage() {
  const used = await readAnonUsage();
  await chrome.storage.local.set({ [ANON_KEY]: { day: startOfUtcDay(), checks: used + 1 } });
  return used + 1;
}

async function cacheEntitlement(entitlement) {
  await chrome.storage.local.set({ [ENTITLEMENT_KEY]: { ...entitlement, cachedAt: Date.now() } });
  return entitlement;
}

async function cachedEntitlement() {
  return (await chrome.storage.local.get(ENTITLEMENT_KEY))[ENTITLEMENT_KEY] || null;
}

/**
 * Current entitlement. Falls back to the last known value when the API is
 * unreachable so a dropped connection does not look like a downgrade.
 */
export async function getEntitlement() {
  if (!(await isSignedIn())) return anonEntitlement(await readAnonUsage());

  try {
    const { user, entitlement } = await fetchAccount();
    return cacheEntitlement({ ...entitlement, signedIn: true, user });
  } catch (error) {
    if (error instanceof ApiError && error.signedOut) {
      return anonEntitlement(await readAnonUsage());
    }
    const cached = await cachedEntitlement();
    return cached
      ? { ...cached, stale: true, signedIn: true }
      : { ...anonEntitlement(await readAnonUsage()), signedIn: true, stale: true };
  }
}

/** Asked before a scan starts; the server decides. */
export async function canStartScan() {
  if (!(await isSignedIn())) {
    const entitlement = anonEntitlement(await readAnonUsage());
    if (entitlement.checksRemaining > 0) return { allowed: true, entitlement };
    return {
      allowed: false,
      entitlement,
      reason: `Sign in to keep checking — you have used all ${ANON_CHECK_LIMIT} free checks for today.`,
    };
  }

  try {
    const { allowed, reason, entitlement } = await fetchScanPermission();
    await cacheEntitlement({ ...entitlement, signedIn: true });
    return { allowed, reason, entitlement };
  } catch (error) {
    if (error instanceof ApiError && error.signedOut) {
      return { allowed: false, reason: 'Your session expired — sign in again.', entitlement: null };
    }
    // Offline: let the scan run rather than holding a paying customer hostage to
    // our own uptime. The count is reconciled when /scans/complete succeeds.
    const cached = await cachedEntitlement();
    return { allowed: true, entitlement: cached, offline: true };
  }
}

/** Called once per completed scan, not per page. */
export async function consumeCheck() {
  if (!(await isSignedIn())) return anonEntitlement(await bumpAnonUsage());
  try {
    const { entitlement } = await reportScanComplete();
    return cacheEntitlement({ ...entitlement, signedIn: true });
  } catch {
    // The scan already happened; losing one count is better than losing the run.
    return (await cachedEntitlement()) || anonEntitlement(0);
  }
}

export async function resetChecks() {
  await chrome.storage.local.remove(ANON_KEY);
  return getEntitlement();
}
