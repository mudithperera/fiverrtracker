/**
 * Stripe billing.
 *
 * Checkout creates the subscription and the Customer Portal handles every change
 * after it — upgrades, downgrades, card updates, cancellation, invoices. Building
 * those screens ourselves would be weeks of work Stripe already hosts.
 *
 * The webhook is the only writer of subscription state. Reading it back from the
 * Checkout success redirect would be tempting and wrong: the redirect can be
 * closed, replayed, or never followed, and it is not authenticated.
 */

import Stripe from 'stripe';
import { PAID_PLAN_IDS, PLANS } from './plans.js';
import {
  claimEvent,
  findSubscription,
  findSubscriptionByCustomer,
  saveStripeCustomer,
  saveSubscription,
} from './db.js';

export function createStripe(env) {
  return new Stripe(env.stripe.secretKey, { apiVersion: '2024-06-20' });
}

export function priceIdFor(env, plan, interval) {
  const prices = env.stripe.prices[plan];
  return prices ? prices[interval] || null : null;
}

/** Reverse lookup so a webhook can tell which plan a price belongs to. */
export function planForPrice(env, priceId) {
  for (const plan of PAID_PLAN_IDS) {
    for (const interval of ['month', 'year']) {
      if (env.stripe.prices[plan]?.[interval] === priceId) return { plan, interval };
    }
  }
  return { plan: 'free', interval: null };
}

/** Find or create the Stripe customer for a user, remembering it locally. */
export async function ensureCustomer(stripe, sql, user) {
  const existing = await findSubscription(sql, user.id);
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name || undefined,
    // Lets us recover the user from a webhook even if our own row is missing.
    metadata: { userId: user.id },
  });
  await saveStripeCustomer(sql, user.id, customer.id);
  return customer.id;
}

export async function createCheckoutSession(stripe, env, { customerId, plan, interval, userId }) {
  if (!PLANS[plan] || plan === 'free') throw new Error(`Not a purchasable plan: ${plan}`);
  const price = priceIdFor(env, plan, interval);
  if (!price) throw new Error(`No Stripe price configured for ${plan}/${interval}`);

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: userId,
    allow_promotion_codes: true,
    success_url: `${env.publicUrl}/billing/done?status=success`,
    cancel_url: `${env.publicUrl}/billing/done?status=cancelled`,
    subscription_data: { metadata: { userId } },
  });
}

export async function createPortalSession(stripe, env, customerId) {
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.publicUrl}/billing/done?status=returned`,
  });
}

// --- webhook -----------------------------------------------------------------

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/**
 * Apply a verified Stripe event.
 *
 * @returns {Promise<{handled: boolean, reason?: string}>}
 */
export async function applyWebhookEvent(sql, env, event) {
  // Stripe guarantees at-least-once delivery, so replays must be no-ops.
  const fresh = await claimEvent(sql, event.id);
  if (!fresh) return { handled: false, reason: 'duplicate' };

  if (!SUBSCRIPTION_EVENTS.has(event.type)) {
    return { handled: false, reason: 'ignored' };
  }

  const subscription = event.data.object;
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

  const userId =
    subscription.metadata?.userId ||
    (await findSubscriptionByCustomer(sql, customerId))?.userId ||
    null;

  if (!userId) return { handled: false, reason: 'unknown-customer' };

  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  const { plan, interval } = planForPrice(env, priceId);

  await saveSubscription(sql, userId, {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    // A deleted subscription grants nothing regardless of which price it had.
    plan: event.type === 'customer.subscription.deleted' ? 'free' : plan,
    status: event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status,
    interval,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
  });

  return { handled: true };
}
