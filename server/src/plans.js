/**
 * Plan definitions and entitlement maths.
 *
 * Pure and dependency-free so it can be unit tested, and so the same shape can be
 * mirrored in the extension without dragging server code across.
 *
 * The tiering follows cost, not feature count: per-country tracking is the only
 * thing that spends real money (residential proxy bandwidth), so it is the thing
 * gated to the top tier. Everything else is cheap once the scan exists.
 */

/** Stripe subscription statuses that should grant paid access. */
export const ACTIVE_STATUSES = new Set(['active', 'trialing']);

/**
 * `past_due` keeps access until Stripe gives up retrying — cutting a paying
 * customer off over a temporarily declined card loses more than it protects.
 */
export const GRACE_STATUSES = new Set(['past_due']);

export const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    dailyChecks: 5,
    trackedKeywords: 0,
    geoTracking: false,
    competitors: 0,
    exports: false,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    dailyChecks: null, // unlimited
    trackedKeywords: 10,
    geoTracking: false,
    competitors: 3,
    exports: true,
  },
  business: {
    id: 'business',
    label: 'Business',
    dailyChecks: null,
    trackedKeywords: 50,
    geoTracking: true,
    competitors: 20,
    exports: true,
  },
};

export const PAID_PLAN_IDS = ['pro', 'business'];

export function getPlan(id) {
  return PLANS[id] || PLANS.free;
}

/**
 * Which plan a subscription row actually grants right now.
 *
 * Deliberately conservative: an unknown plan id, an unknown status, or a lapsed
 * period all fall back to free. A bug here should under-grant, never over-grant.
 */
export function planFromSubscription(subscription, now = Date.now()) {
  if (!subscription) return 'free';
  const { plan, status, currentPeriodEnd } = subscription;
  if (!PLANS[plan] || plan === 'free') return 'free';

  if (ACTIVE_STATUSES.has(status)) return plan;

  // Grace period: keep access until the paid period genuinely ends.
  if (GRACE_STATUSES.has(status)) {
    const endsAt = currentPeriodEnd ? new Date(currentPeriodEnd).getTime() : 0;
    return endsAt > now ? plan : 'free';
  }

  return 'free';
}

/**
 * The entitlement object the extension renders from.
 *
 * @param {object|null} subscription Row from the subscriptions table.
 * @param {number} checksToday Completed scans counted since midnight UTC.
 */
export function buildEntitlement(subscription, checksToday = 0, now = Date.now()) {
  const planId = planFromSubscription(subscription, now);
  const plan = getPlan(planId);
  const unlimited = plan.dailyChecks === null;

  return {
    plan: planId,
    planLabel: plan.label,
    unlimited,
    limit: plan.dailyChecks,
    checksUsed: checksToday,
    checksRemaining: unlimited ? null : Math.max(0, plan.dailyChecks - checksToday),
    features: {
      trackedKeywords: plan.trackedKeywords,
      geoTracking: plan.geoTracking,
      competitors: plan.competitors,
      exports: plan.exports,
    },
    subscription: subscription
      ? {
          status: subscription.status,
          cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
          currentPeriodEnd: subscription.currentPeriodEnd || null,
        }
      : null,
  };
}

/** Whether a scan may start, and why not if it may not. */
export function canStartScan(entitlement) {
  if (entitlement.unlimited) return { allowed: true };
  if (entitlement.checksRemaining > 0) return { allowed: true };
  return {
    allowed: false,
    reason:
      `You have used all ${entitlement.limit} free checks for today. ` +
      'Upgrade for unlimited checks, or try again tomorrow.',
  };
}
