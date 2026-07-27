# Fiverr Gig Ranking Tracker — API

Owns the three things the extension cannot be trusted with: **who the user is**,
**what they have paid for**, and **how much they have used**.

The extension renders entitlements. It never decides them. `chrome.storage` is
user-writable, so anything gated in the client is decoration — the server
re-checks every call.

## Stack

Node 22 · Hono · Postgres (Neon) · Stripe · Google OAuth. No ORM: the schema is
four tables and the query shapes are stable, so an ORM would add a dependency and
a mental model without removing work.

## Plans

| Plan | Price | Daily checks | Tracked keywords | Geo | Competitors |
|---|---|---|---|---|---|
| Free | — | 5 | 0 | — | 0 |
| Pro | $5/mo · $50/yr | unlimited | 10 | — | 3 |
| Business | $15/mo · $150/yr | unlimited | 50 | ✓ | 20 |

Tiering follows **cost, not feature count**. Per-country tracking is the only
feature that spends real money per scan (residential proxy bandwidth), so it is
the one gated to the top tier. Everything else is nearly free once a scan exists.

## Setup

### 1. Database

Create a Neon project, copy the pooled connection string. Migrations run
automatically at boot from `src/migrations/`, tracked in `schema_migrations`.

### 2. Google OAuth

Google Cloud Console → APIs & Services → Credentials → **OAuth client ID** →
*Web application* (not "Chrome extension" — the code exchange happens on this
server, not in the extension).

Authorised redirect URI:

```
https://<your-api-domain>/auth/google/callback
```

Configure the consent screen with the `openid`, `email`, `profile` scopes. While
the app is in *Testing*, only accounts on the test-user list can sign in —
publish it before launch or sign-ups will silently fail for everyone else.

### 3. Stripe

Create two products with a monthly and a yearly price each:

| Product | Monthly | Yearly |
|---|---|---|
| Pro | $5.00 | $50.00 |
| Business | $15.00 | $150.00 |

Copy the six `price_…` ids into the env vars below. Then enable the **Customer
Portal** (Settings → Billing → Customer portal) with cancellation and plan
switching turned on — that is what `/billing/portal` opens, and it saves building
cancel/upgrade/invoice screens yourself.

Add a webhook endpoint pointing at `https://<your-api-domain>/webhooks/stripe`,
subscribed to:

```
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

The webhook is the **only** writer of subscription state. Reading it from the
Checkout success redirect is tempting and wrong: that redirect can be closed,
replayed, or never followed, and it is not authenticated.

### 4. Environment

Copy `.env.example` and fill it in. The server refuses to boot with anything
required missing, which beats a request-time crash three days later.

`ALLOWED_EXTENSION_IDS` matters: the OAuth flow redirects back to
`https://<extension-id>.chromiumapp.org/`, so leaving it empty in production
would let any extension complete a sign-in against your backend. Empty is treated
as development mode.

### 5. Run

```bash
npm install
npm run dev     # or: npm start
npm test        # plan + entitlement logic
```

### 6. Point the extension at it

The extension defaults to `https://api.fiverrtracker.app`. For local development,
set the override from the panel's DevTools console:

```js
chrome.storage.local.set({ apiBase: 'http://localhost:8787' })
```

and add that origin to `host_permissions` in `manifest.json`. Note Chrome's
extension id must be stable for OAuth to work — add a `key` to the manifest, or
load the extension from the same path every time.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness |
| GET | `/auth/google/start` | — | Begins sign-in; `?redirect=` is the extension callback |
| GET | `/auth/google/callback` | — | Google returns here; redirects back with `#token=` |
| GET | `/me` | ✓ | User + entitlement |
| GET | `/scans/permission` | ✓ | May a scan start? |
| POST | `/scans/complete` | ✓ | Counts one completed scan |
| POST | `/billing/checkout` | ✓ | `{plan, interval}` → Checkout URL |
| POST | `/billing/portal` | ✓ | → Customer Portal URL |
| POST | `/webhooks/stripe` | signature | Subscription state |

## Design notes

**Sessions are JWTs, 30 days, stateless.** Fine at this size, but it means sign-out
is client-side only and a stolen token stays valid until it expires. When that
matters, add a `sessions` table and check it in `requireAuth`.

**Usage is one row per user per UTC day**, not a running counter, so daily quotas
reset without a scheduled job and history stays inspectable when someone disputes
a limit.

**Webhooks are idempotent** via `processed_events` — Stripe delivers at least
once, so replays must be no-ops. Verified events always return 200 even when
ignored: a non-2xx makes Stripe retry, and retrying will not fix an event we
decided not to act on.

**Entitlement derivation fails closed.** An unknown plan id, unknown status, or
lapsed period all fall back to free. `past_due` is the one exception — it keeps
access until the paid period genuinely ends, because cutting off a paying
customer over one declined card costs more than it saves.

## Not built yet

- **Scheduled tracking + the proxy worker.** This is the feature people subscribe
  for; the API above is the seam it plugs into.
- **Session revocation** (see above).
- **Rate limiting.** Add it before launch — `/auth/google/start` and
  `/billing/checkout` are the exposed surfaces.
