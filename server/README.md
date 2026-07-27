# RankPeek — API

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

This build's id is **`jnmcfoojlghechjiacmllggbcffclhca`**, pinned by the `key` in
`manifest.json`. Without that key Chrome derives a new id from the load path, so
the id changes between machines and every reinstall — and each change breaks the
OAuth redirect until you update this variable. `extension-key.pem` is the matching
private key: it is gitignored, and losing it means you cannot publish an update
that Chrome accepts as the same extension. Back it up somewhere you trust.

### 5. Run

```bash
npm install
npm run dev     # or: npm start
npm test        # plan + entitlement logic
```

### 6. Point the extension at it

The extension defaults to `https://api.rankpeek.app`. For local development,
set the override from the panel's DevTools console:

```js
chrome.storage.local.set({ apiBase: 'http://localhost:8787' })
```

and add that origin to `host_permissions` in `manifest.json`. Note Chrome's
extension id must be stable for OAuth to work — add a `key` to the manifest, or
load the extension from the same path every time.

## What to buy

| | Recommendation | Why |
|---|---|---|
| **VPS** | 2 vCPU / 4GB, ~$5–7/mo (Hetzner CX22, or DigitalOcean / Vultr equivalent) | Chromium alone wants ~1GB while scanning; 2GB total leaves nothing for Postgres and the API. Location barely matters — the proxy decides where scans appear from. |
| **Database** | The bundled Postgres to start | One box, no extra bill, backups included below. Move to managed Postgres (Neon has a free tier) when losing data would be worse than the migration. Switching is one `DATABASE_URL`. |
| **Proxy** | Residential **rotating** with country targeting | Static ISP addresses are wasted here: each scan is a handful of page loads, and rotation spreads them. Buy the smallest bandwidth pack first. |

**Do not buy proxy bandwidth yet.** Run the direct one-shot first. If it comes back
`ok`, proxies are only needed for the per-country tier, which has no customers
yet — so the correct first purchase is nothing.

### What proxy bandwidth actually costs

With images, fonts and stylesheets blocked, a search page is ~400KB, and one scan
is 3 pages — so roughly **1.2MB per keyword, per sort mode, per day**.

100 keyword/sort combinations ≈ 120MB/day ≈ **3.6GB/month**, or about $11–18 at
typical residential rates. And because scans are shared, that figure tracks
distinct keywords rather than subscriber count: the hundredth user tracking "logo
design" costs nothing.

Measure a real week before buying a bigger pack.

## Deploying

### On a VPS (docker compose)

Everything on one box — Postgres, API, worker, and Caddy for automatic HTTPS.

```bash
git clone <repo> rankpeek && cd rankpeek
cp server/.env.example .env      # note: repo root, not server/
# edit .env — API_DOMAIN, POSTGRES_PASSWORD, Google, Stripe, JWT_SECRET
docker compose up -d
docker compose logs -f api
```

Point `API_DOMAIN`'s A record at the VPS and open 80 and 443 first; Caddy gets
the certificate on first boot and renews it thereafter.

Two details worth not rediscovering the hard way. Postgres is deliberately not
published to the host — an exposed Postgres is found by scanners within hours.
And the worker container gets a 1GB `/dev/shm`, because Chromium crashes on
Docker's 64MB default in a way that looks exactly like Fiverr blocking us.

**Using your proxy from the VPS.** Set `PROXY_HOST` / `PROXY_PORT` /
`PROXY_USERNAME_TEMPLATE` / `PROXY_PASSWORD` in `.env` and the worker routes
scans through it, substituting `{country}` per scan. If you run a local proxy
gateway on the VPS pointing at your upstream provider, that is the same thing —
set `PROXY_HOST=127.0.0.1` and the port it listens on. Nothing in the code cares
which it is.

Note the VPS itself cannot *be* the residential proxy: it has one datacentre IP,
in one location. It can host the gateway, but the exit addresses still come from
your provider.

### On Fly.io

```bash
fly launch --no-deploy
fly secrets set DATABASE_URL=… JWT_SECRET=… GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
               STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=… PUBLIC_URL=https://api.rankpeek.app \
               ALLOWED_EXTENSION_IDS=jnmcfoojlghechjiacmllggbcffclhca
fly deploy
```

`fly.toml` runs two processes from one image: `api` and `worker`. They are kept on
separate machines because a scan can occupy a browser for minutes and sign-in
should not queue behind it. The API never scales to zero — Stripe webhooks and the
OAuth callback arrive unannounced and a cold start can outlast their timeout.

The Docker tag must match the `playwright` version pinned in `package.json`. A
mismatch fails at runtime with *"Executable doesn't exist"*.

The worker machine gets 2GB. Chromium under 512MB gets OOM-killed part-way through
a scan, which looks exactly like Fiverr blocking us.

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
| POST | `/account/delete` | ✓ | Erases the account (real deletion) |
| POST | `/webhooks/stripe` | signature | Subscription state |
| GET | `/privacy`, `/terms` | — | Public legal pages |

Rate limits apply to `/auth/google/start`, `/billing/*` and `/scans/complete` —
the routes a stranger can reach or that cost money to serve. They are in-process,
so two instances mean two counters; that is fine for stopping one client hammering
a route and would need Redis only if the exact global number ever mattered.

## The tracking worker

The image starts an X display for every command (see `docker/with-display.sh`),
so real Chrome can run with a window and no wrapper is needed — `xvfb-run` fails
silently in this base image, which costs an afternoon to work out.

```bash
npm run worker -- --once --keyword "logo design"              # your own IP
npm run worker -- --once --keyword "logo design" --country us # through the proxy
npm run worker -- --once --keyword "logo design" --headed     # watch it happen
npm run worker                                                # continuous
```

**Run the one-shot first, without the proxy.** Everything about automated tracking
rests on a single unproven assumption: that Fiverr serves a real results page to a
headless browser. It fronts with PerimeterX and returns 403 to plain HTTP clients.
The one-shot answers that in about thirty seconds, needs no database or account,
and exits non-zero if it hits a wall.

- `status: ok` — scanning works. Proxies are then an upgrade for per-country
  ranks, not a prerequisite, and the cheapest scans cost nothing.
- `status: blocked` — try again with `--country`. If a clean residential IP fixes
  it, proxies are mandatory and every scan now has a bandwidth cost.
- **Blocked on both** — the block is fingerprinting, not IP reputation, and no
  proxy will fix it. Headless Chromium is detectable on a dozen signals a
  residential address does not touch. The next move there is `--headed` under
  xvfb, or a stealth plugin, not better IPs.

Test in that order. It is the difference between "we need proxies" and "we need a
different browser", and they have very different costs.

### How it keeps proxy costs down

Two decisions, both hard to retrofit:

**Scans are shared, not per-user.** Ten sellers tracking "logo design" is one
scan. The full ordered result set is stored once in `scan_results`, and each
user's rank is a query against it. Bandwidth grows with distinct keywords, not
subscribers — and a new subscriber inherits history from day one.

**Images, fonts, media and stylesheets are aborted.** A Fiverr search page is
2–4MB fully loaded and about 400KB without them, and none of it is needed:
everything read comes from `data-gig-id` attributes and hrefs. That is a 5–8×
cut in the only per-scan cost that matters.

### Shared logic, not reimplemented

The worker imports `classifyCards` from `src/lib/cards.js` and `buildSearchUrl`
from `src/lib/sortmodes.js` — the same modules the extension uses. A rank recorded
overnight and a rank shown in the panel come from the same code and cannot
disagree.

The one part that *is* duplicated is the DOM sweep, in
`src/worker/collect.js`: a classic content script cannot be imported, and
`page.evaluate` cannot close over anything. `test/collect.test.js` runs both
against one fixture in a real browser and fails if they drift.

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

- **API endpoints for tracked keywords.** The worker and its queries exist; the
  extension cannot add or list tracked keywords yet.
- **Email alerts on rank movement.** Needs a provider (Resend or Postmark).
- **Session revocation** (see above).
- **Rate limiting.** Add it before launch — `/auth/google/start` and
  `/billing/checkout` are the exposed surfaces.
