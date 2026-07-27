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

/**
 * Display prices, kept here so the extension can render a plan picker without
 * hardcoding amounts that would drift from Stripe. Stripe remains the authority
 * on what is actually charged — these are labels, and the `price_…` ids in the
 * environment are what Checkout uses.
 */
export const PRICING = {
  pro: {
    month: { display: '$5', suffix: '/mo' },
    year: { display: '$50', suffix: '/yr', note: '2 months free' },
  },
  business: {
    month: { display: '$15', suffix: '/mo' },
    year: { display: '$150', suffix: '/yr', note: '2 months free' },
  },
};

/** One-line summaries for the plan picker. */
const BLURBS = {
  free: 'Check a handful of rankings by hand each day.',
  pro: 'Unlimited manual checks, plus daily automatic tracking.',
  business: 'Everything in Pro, plus per-country ranks and bigger limits.',
};

function featureLines(plan) {
  const lines = [
    plan.dailyChecks === null ? 'Unlimited manual checks' : `${plan.dailyChecks} manual checks a day`,
  ];
  // Automated tracking is not built yet. Advertising it as though it were invites
  // chargebacks and one-star reviews, so the unbuilt lines say so until the worker
  // ships — at which point deleting SOON is the whole change.
  const SOON = ' (coming soon)';
  if (plan.trackedKeywords) lines.push(`${plan.trackedKeywords} keywords tracked daily${SOON}`);
  if (plan.competitors) lines.push(`${plan.competitors} competitors tracked${SOON}`);
  if (plan.geoTracking) lines.push(`Per-country rankings${SOON}`);
  if (plan.exports) lines.push('CSV export');
  return lines;
}

/**
 * Public plan catalogue for the picker.
 *
 * @param {Record<string, Record<string, boolean>>} availability
 *        Which plan/interval combinations have a Stripe price configured. An
 *        interval with no price id is simply not offered, rather than offered and
 *        then failing at checkout.
 */
export function describePlans(availability = {}) {
  return Object.values(PLANS).map((plan) => {
    const intervals = {};
    for (const interval of ['month', 'year']) {
      if (plan.id === 'free' || !availability[plan.id]?.[interval]) continue;
      intervals[interval] = PRICING[plan.id]?.[interval] || null;
    }
    return {
      id: plan.id,
      label: plan.label,
      blurb: BLURBS[plan.id] || '',
      features: featureLines(plan),
      intervals,
      purchasable: Object.keys(intervals).length > 0,
    };
  });
}

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
