import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLANS,
  buildEntitlement,
  canStartScan,
  describePlans,
  planFromSubscription,
} from '../src/plans.js';

const NOW = Date.UTC(2026, 6, 27);
const future = new Date(NOW + 7 * 864e5);
const past = new Date(NOW - 7 * 864e5);

test('no subscription means free', () => {
  assert.equal(planFromSubscription(null, NOW), 'free');
  assert.equal(planFromSubscription(undefined, NOW), 'free');
});

test('active and trialing subscriptions grant their plan', () => {
  assert.equal(planFromSubscription({ plan: 'pro', status: 'active' }, NOW), 'pro');
  assert.equal(planFromSubscription({ plan: 'business', status: 'trialing' }, NOW), 'business');
});

test('past_due keeps access until the paid period actually ends', () => {
  // Cutting off a paying customer over one declined card costs more than it saves,
  // but the grace must not outlive the period they paid for.
  assert.equal(
    planFromSubscription({ plan: 'pro', status: 'past_due', currentPeriodEnd: future }, NOW),
    'pro',
  );
  assert.equal(
    planFromSubscription({ plan: 'pro', status: 'past_due', currentPeriodEnd: past }, NOW),
    'free',
  );
  assert.equal(planFromSubscription({ plan: 'pro', status: 'past_due' }, NOW), 'free');
});

test('cancelled, unpaid and unknown statuses grant nothing', () => {
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'weird']) {
    assert.equal(
      planFromSubscription({ plan: 'business', status, currentPeriodEnd: future }, NOW),
      'free',
      status,
    );
  }
});

test('an unknown plan id falls back to free rather than granting it', () => {
  // A bug here should under-grant, never over-grant.
  assert.equal(planFromSubscription({ plan: 'enterprise', status: 'active' }, NOW), 'free');
  assert.equal(planFromSubscription({ plan: 'free', status: 'active' }, NOW), 'free');
});

test('free entitlement counts down the daily allowance', () => {
  const entitlement = buildEntitlement(null, 2, NOW);
  assert.equal(entitlement.plan, 'free');
  assert.equal(entitlement.unlimited, false);
  assert.equal(entitlement.limit, PLANS.free.dailyChecks);
  assert.equal(entitlement.checksRemaining, PLANS.free.dailyChecks - 2);
  assert.equal(entitlement.features.geoTracking, false);
});

test('remaining checks never go negative', () => {
  assert.equal(buildEntitlement(null, 99, NOW).checksRemaining, 0);
});

test('paid entitlement is unlimited and reports its feature limits', () => {
  const entitlement = buildEntitlement(
    { plan: 'business', status: 'active', currentPeriodEnd: future, cancelAtPeriodEnd: true },
    40,
    NOW,
  );
  assert.equal(entitlement.plan, 'business');
  assert.equal(entitlement.unlimited, true);
  assert.equal(entitlement.checksRemaining, null);
  assert.equal(entitlement.features.geoTracking, true);
  assert.equal(entitlement.features.trackedKeywords, PLANS.business.trackedKeywords);
  assert.equal(entitlement.subscription.cancelAtPeriodEnd, true);
});

test('geo tracking is the only feature gated to the top tier', () => {
  // It is the one feature that costs real money per scan (residential proxy
  // bandwidth), which is why it sits where it does.
  assert.equal(buildEntitlement({ plan: 'pro', status: 'active' }, 0, NOW).features.geoTracking, false);
  assert.equal(
    buildEntitlement({ plan: 'business', status: 'active' }, 0, NOW).features.geoTracking,
    true,
  );
});

test('describePlans only advertises intervals that have a Stripe price', () => {
  // Offering an interval that then fails at checkout is worse than not offering
  // it, so availability comes from the configured price ids.
  const plans = describePlans({
    pro: { month: true, year: false },
    business: { month: false, year: false },
  });
  const byId = Object.fromEntries(plans.map((p) => [p.id, p]));

  assert.deepEqual(Object.keys(byId.pro.intervals), ['month']);
  assert.equal(byId.pro.purchasable, true);
  assert.equal(byId.business.purchasable, false);
  assert.deepEqual(byId.business.intervals, {});
});

test('describePlans never makes the free plan purchasable', () => {
  const [free] = describePlans({ free: { month: true, year: true } });
  assert.equal(free.id, 'free');
  assert.equal(free.purchasable, false);
  assert.ok(free.features.length, 'free still lists what it includes');
});

test('canStartScan blocks a spent free allowance and allows paid plans', () => {
  assert.equal(canStartScan(buildEntitlement(null, 0, NOW)).allowed, true);

  const spent = canStartScan(buildEntitlement(null, PLANS.free.dailyChecks, NOW));
  assert.equal(spent.allowed, false);
  assert.match(spent.reason, /today/);

  assert.equal(canStartScan(buildEntitlement({ plan: 'pro', status: 'active' }, 500, NOW)).allowed, true);
});

// --- advertising only what the running service can do ------------------------

const businessFeatures = (capabilities) =>
  describePlans({ business: { month: true } }, capabilities).find((p) => p.id === 'business')
    .features;

test('per-country rankings are sold plainly once a proxy is configured', () => {
  // The feature ships: the gateway relays, the extension routes Fiverr through
  // it, and a completed scan records the country it actually ran through. A
  // "coming soon" on a working feature is a sale we decline to make.
  const geo = businessFeatures({ geoLive: true }).find((line) => /per-country/i.test(line));
  assert.equal(geo, 'Per-country rankings');
});

test('per-country rankings stay "coming soon" when nothing is configured', () => {
  // With no proxies, /proxy/session refuses every country. Promising it anyway
  // is how a Business subscription becomes a refund.
  const geo = businessFeatures({ geoLive: false }).find((line) => /per-country/i.test(line));
  assert.match(geo, /coming soon/);
});

test('the cautious answer is the default', () => {
  const geo = businessFeatures(undefined).find((line) => /per-country/i.test(line));
  assert.match(geo, /coming soon/, 'a caller that forgot to ask must not over-promise');
});

test('the unbuilt daily scheduler is still marked, whatever the proxies do', () => {
  // Routing a scan through a country and running one every morning are different
  // features; shipping the first must not quietly advertise the second.
  const features = businessFeatures({ geoLive: true });
  assert.match(features.find((l) => /keywords tracked daily/.test(l)), /coming soon/);
  assert.match(features.find((l) => /competitors tracked/.test(l)), /coming soon/);
});
