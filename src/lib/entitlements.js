/**
 * Plan / quota gating.
 *
 * IMPORTANT: this is local-only and therefore NOT enforcement. Anyone can open
 * DevTools and rewrite chrome.storage. It exists so the "N of 5 free checks left"
 * and "Upgrade" affordances render, and so there is exactly one seam to swap when
 * the backend lands — at that point `getEntitlement` and `consumeCheck` become API
 * calls and the server, not the client, becomes the authority on the count.
 */

export const ENTITLEMENT_KEY = 'entitlement';
export const FREE_CHECK_LIMIT = 5;

export const PLAN = {
  FREE: 'free',
  UNLIMITED: 'unlimited',
};

function defaults() {
  return { plan: PLAN.FREE, checksUsed: 0, updatedAt: Date.now() };
}

export async function getEntitlement() {
  const stored = (await chrome.storage.local.get(ENTITLEMENT_KEY))[ENTITLEMENT_KEY];
  const record = { ...defaults(), ...(stored || {}) };
  const unlimited = record.plan === PLAN.UNLIMITED;
  return {
    ...record,
    unlimited,
    checksRemaining: unlimited ? Infinity : Math.max(0, FREE_CHECK_LIMIT - record.checksUsed),
    limit: FREE_CHECK_LIMIT,
  };
}

export async function canStartScan() {
  const entitlement = await getEntitlement();
  if (entitlement.unlimited) return { allowed: true, entitlement };
  if (entitlement.checksRemaining > 0) return { allowed: true, entitlement };
  return {
    allowed: false,
    entitlement,
    reason: `You have used all ${FREE_CHECK_LIMIT} free ranking checks.`,
  };
}

/** Called once per completed scan, not per page. */
export async function consumeCheck() {
  const entitlement = await getEntitlement();
  if (entitlement.unlimited) return entitlement;
  const next = {
    plan: entitlement.plan,
    checksUsed: entitlement.checksUsed + 1,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [ENTITLEMENT_KEY]: next });
  return getEntitlement();
}

/** Dev/testing affordance until real billing exists. */
export async function setPlan(plan) {
  const entitlement = await getEntitlement();
  await chrome.storage.local.set({
    [ENTITLEMENT_KEY]: { plan, checksUsed: entitlement.checksUsed, updatedAt: Date.now() },
  });
  return getEntitlement();
}

export async function resetChecks() {
  const entitlement = await getEntitlement();
  await chrome.storage.local.set({
    [ENTITLEMENT_KEY]: { plan: entitlement.plan, checksUsed: 0, updatedAt: Date.now() },
  });
  return getEntitlement();
}
