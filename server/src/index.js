/**
 * API for the RankPeek extension.
 *
 * Owns the three things a client cannot be trusted with: who the user is, what
 * they have paid for, and how much they have used. The extension renders these;
 * it does not decide them.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadEnv } from './env.js';
import {
  checksToday,
  createDb,
  deleteUser,
  findSubscription,
  findUserById,
  incrementChecks,
  migrate,
  upsertUser,
} from './db.js';
import {
  buildGoogleAuthUrl,
  exchangeCodeForProfile,
  isAllowedExtensionRedirect,
  issueSession,
  readState,
  requireAuth,
  signState,
} from './auth.js';
import {
  applyWebhookEvent,
  createCheckoutSession,
  createPortalSession,
  createStripe,
  ensureCustomer,
} from './billing.js';
import { PAID_PLAN_IDS, buildEntitlement, canStartScan, describePlans } from './plans.js';
import { rateLimit } from './ratelimit.js';
import { TOKEN_TTL_SECONDS, mintProxyToken } from './proxy/token.js';
import { createProxyGateway } from './proxy/gateway.js';
import { configuredCountries } from './worker/proxies.js';
import { PRIVACY_HTML, TERMS_HTML } from './legal.js';

const env = loadEnv();
const sql = createDb(env.databaseUrl);
const stripe = createStripe(env);
const app = new Hono();

app.use(
  '/*',
  cors({
    // Extensions send Origin: chrome-extension://<id>. Anything else has no
    // business calling this API from a browser.
    origin: (origin) => (origin && origin.startsWith('chrome-extension://') ? origin : ''),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type'],
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

// Public legal pages. The Chrome Web Store will not approve an OAuth extension
// without a privacy policy at a reachable URL.
app.get('/privacy', (c) => c.html(PRIVACY_HTML));
app.get('/terms', (c) => c.html(TERMS_HTML));

// Rate limits on the routes a stranger can reach. Sign-in starts an OAuth round
// trip and checkout creates Stripe objects, so both cost something to serve.
app.use('/auth/google/start', rateLimit({ name: 'signin', limit: 10, windowMs: 60_000 }));
app.use('/billing/checkout', rateLimit({ name: 'checkout', limit: 10, windowMs: 60_000 }));
app.use('/billing/portal', rateLimit({ name: 'portal', limit: 10, windowMs: 60_000 }));
app.use('/scans/complete', rateLimit({ name: 'scans', limit: 120, windowMs: 60_000 }));

/**
 * Plan catalogue for the picker. Public, because the pricing needs to render
 * before anyone signs in. Only intervals with a configured Stripe price are
 * advertised — offering one that then fails at checkout is worse than not
 * offering it.
 */
app.get('/plans', (c) => {
  const availability = {};
  for (const plan of PAID_PLAN_IDS) {
    availability[plan] = {
      month: Boolean(env.stripe.prices[plan]?.month),
      year: Boolean(env.stripe.prices[plan]?.year),
    };
  }
  return c.json({ plans: describePlans(availability) });
});

// --- auth --------------------------------------------------------------------

/**
 * Step 1: the extension opens this in launchWebAuthFlow, passing the callback it
 * wants to be returned to.
 */
app.get('/auth/google/start', async (c) => {
  const target = c.req.query('redirect');
  if (!isAllowedExtensionRedirect(env, target)) {
    return c.json({ error: 'Unrecognised extension redirect.' }, 400);
  }
  return c.redirect(buildGoogleAuthUrl(env, await signState(env, target)));
});

/** Step 2: Google returns here; we mint a session and bounce back to the extension. */
app.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code');
  const target = await readState(env, c.req.query('state'));

  if (!target || !isAllowedExtensionRedirect(env, target)) {
    return c.text('Sign-in expired or was tampered with. Please try again.', 400);
  }
  if (!code) {
    const reason = c.req.query('error') || 'no-code';
    return c.redirect(`${target}#error=${encodeURIComponent(reason)}`);
  }

  try {
    const profile = await exchangeCodeForProfile(env, code);
    const user = await upsertUser(sql, profile);
    const token = await issueSession(env, user);
    // Fragment, not query: fragments are not sent to servers or written to logs.
    return c.redirect(`${target}#token=${encodeURIComponent(token)}`);
  } catch (error) {
    console.error('sign-in failed', error);
    return c.redirect(`${target}#error=${encodeURIComponent('sign-in-failed')}`);
  }
});

// --- account + entitlement ---------------------------------------------------

async function entitlementFor(userId) {
  const [subscription, used] = await Promise.all([
    findSubscription(sql, userId),
    checksToday(sql, userId),
  ]);
  return buildEntitlement(subscription, used);
}

app.get('/me', requireAuth(env), async (c) => {
  const { userId } = c.get('session');
  const user = await findUserById(sql, userId);
  if (!user) return c.json({ error: 'Account no longer exists.' }, 401);

  return c.json({
    user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
    entitlement: await entitlementFor(userId),
  });
});

/**
 * Erase the account. Required by the Chrome Web Store's user-data policy and by
 * GDPR, and it has to be real deletion rather than a flag.
 *
 * Deliberately does not cancel Stripe subscriptions: cancelling someone's billing
 * as a side effect of a different action is worse than telling them to do it, and
 * the policy page says so plainly.
 */
app.post('/account/delete', requireAuth(env), async (c) => {
  const { userId } = c.get('session');
  await deleteUser(sql, userId);
  return c.json({ ok: true });
});

/**
 * Asked before a scan starts. The extension must not decide this for itself —
 * chrome.storage is user-writable, so a client-side quota is decoration.
 */
app.get('/scans/permission', requireAuth(env), async (c) => {
  const entitlement = await entitlementFor(c.get('session').userId);
  return c.json({ ...canStartScan(entitlement), entitlement });
});

/** Called once per *completed* scan, not per page. */
app.post('/scans/complete', requireAuth(env), async (c) => {
  const { userId } = c.get('session');
  const entitlement = await entitlementFor(userId);
  if (!entitlement.unlimited) await incrementChecks(sql, userId);
  return c.json({ entitlement: await entitlementFor(userId) });
});

// --- billing -----------------------------------------------------------------

/**
 * Hand out a short-lived credential for the proxy gateway.
 *
 * The customer never receives the real proxy login — an extension's storage is
 * readable by whoever runs it, so anything sent to the client is public. They get
 * a token naming themselves and the country; the gateway trades it for the real
 * connection server-side.
 */
app.get('/proxy/session', requireAuth(env), async (c) => {
  const country = String(c.req.query('country') || '').toLowerCase();
  const available = configuredCountries();

  if (!available.includes(country)) {
    return c.json({ error: `No proxy available for ${country || 'that country'}.` }, 400);
  }

  const { userId } = c.get('session');
  const entitlement = await entitlementFor(userId);
  if (!entitlement.features.geoTracking) {
    return c.json(
      { error: 'Country selection is a Business feature.', upgrade: 'business' },
      403,
    );
  }

  return c.json({
    host: env.proxyGateway.host,
    port: env.proxyGateway.port,
    username: await mintProxyToken(env, { userId, country }),
    // Chrome insists on sending something; the gateway ignores it.
    password: 'x',
    country,
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
  });
});

/** Countries a customer may pick, so the extension does not hardcode a list. */
app.get('/proxy/countries', (c) => c.json({ countries: configuredCountries() }));

app.post('/billing/checkout', requireAuth(env), async (c) => {
  const { plan, interval } = await c.req.json().catch(() => ({}));
  if (!PAID_PLAN_IDS.includes(plan)) return c.json({ error: 'Unknown plan.' }, 400);
  if (!['month', 'year'].includes(interval)) return c.json({ error: 'Unknown interval.' }, 400);

  const user = await findUserById(sql, c.get('session').userId);
  if (!user) return c.json({ error: 'Account no longer exists.' }, 401);

  try {
    const customerId = await ensureCustomer(stripe, sql, user);
    const session = await createCheckoutSession(stripe, env, {
      customerId,
      plan,
      interval,
      userId: user.id,
    });
    return c.json({ url: session.url });
  } catch (error) {
    console.error('checkout failed', error);
    return c.json({ error: 'Could not start checkout.' }, 500);
  }
});

app.post('/billing/portal', requireAuth(env), async (c) => {
  const user = await findUserById(sql, c.get('session').userId);
  if (!user) return c.json({ error: 'Account no longer exists.' }, 401);
  try {
    const customerId = await ensureCustomer(stripe, sql, user);
    const session = await createPortalSession(stripe, env, customerId);
    return c.json({ url: session.url });
  } catch (error) {
    console.error('portal failed', error);
    return c.json({ error: 'Could not open the billing portal.' }, 500);
  }
});

app.get('/billing/done', (c) =>
  c.html(
    `<!doctype html><meta charset="utf-8"><title>All set</title>
     <body style="font:16px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0">
       <p>You can close this tab and return to the extension.</p>
     </body>`,
  ),
);

/**
 * Stripe webhooks. Signature verification needs the exact bytes Stripe sent, so
 * this reads the raw body rather than parsed JSON.
 */
app.post('/webhooks/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  const raw = await c.req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, env.stripe.webhookSecret);
  } catch (error) {
    console.error('webhook signature check failed', error.message);
    return c.json({ error: 'Bad signature.' }, 400);
  }

  try {
    const result = await applyWebhookEvent(sql, env, event);
    // Always 200 on a verified event: a non-2xx makes Stripe retry, and retrying
    // will not fix an event we have decided not to act on.
    return c.json({ received: true, ...result });
  } catch (error) {
    console.error('webhook handling failed', event.type, error);
    return c.json({ error: 'Handler failed.' }, 500);
  }
});

await migrate(sql);
serve({ fetch: app.fetch, port: env.port }, ({ port }) => {
  console.log(`API listening on :${port}`);
});

// The gateway is a raw CONNECT proxy, so it cannot share a port with the HTTP
// API. Disabled unless a port is configured, because an unconfigured relay
// listening by default is how open proxies happen.
if (env.proxyGateway.port && env.proxyGateway.enabled) {
  createProxyGateway(env).listen(env.proxyGateway.port, () => {
    console.log(`Proxy gateway listening on :${env.proxyGateway.port}`);
  });
}
