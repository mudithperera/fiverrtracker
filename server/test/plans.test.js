import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLANS,
  buildEntitlement,
  canStartScan,
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

test('canStartScan blocks a spent free allowance and allows paid plans', () => {
  assert.equal(canStartScan(buildEntitlement(null, 0, NOW)).allowed, true);

  const spent = canStartScan(buildEntitlement(null, PLANS.free.dailyChecks, NOW));
  assert.equal(spent.allowed, false);
  assert.match(spent.reason, /today/);

  assert.equal(canStartScan(buildEntitlement({ plan: 'pro', status: 'active' }, 500, NOW)).allowed, true);
});
