# RankPeek

A Chrome extension (MV3) that tells a Fiverr seller where their gig ranks for a keyword,
across all three of Fiverr's sort orders, and — the paid differentiator — **from a
different country**, by routing the search through a proxy gateway we run.

`README.md` documents the extension for users and contributors. This file is the part
that isn't obvious from the code: the constraints that were learned the hard way, the
approaches already tried and ruled out, and what state the project is actually in.

## Layout

```
manifest.json        MV3 manifest. `key` pins the extension id (see "Secrets").
src/background.js    Service worker — the scan state machine. Start here.
src/content.js       Injected on Fiverr pages. Dumb DOM reader + sort detection.
src/panel.*          Side panel UI. A pure renderer; holds no scan state.
src/lib/*.js         Pure logic, all unit-tested, no chrome.* calls.
server/src/          Hono API: Google auth, Stripe billing, entitlements.
server/src/proxy/    The CONNECT gateway customers point their browser at.
server/src/worker/   Server-side scanning. ABANDONED — see below. Don't build on it.
```

The scan state machine lives in the **service worker**, never the panel: a scan drives up
to 30 navigations, each one destroys the content script, the panel can close at any
moment, and MV3 evicts the worker at will. The cursor is persisted to
`chrome.storage.local` after every page.

## Constraints that are not up for rediscovery

Each of these cost a debugging round or more. Changing any of them needs evidence, not a
plausible-sounding argument.

**Fiverr's sort parameter is `filter`, with values `auto` / `rating` / `new`.** Not
`sort_by`. I guessed `sort_by=best_selling` once; it silently returned relevance-sorted
results and the scan reported confident, wrong numbers. Verification now reads Fiverr's
own sort control via `detectActiveSort()` rather than diffing result sets — a result-set
diff passed the broken parameter, because two sort orders share plenty of gigs.

**Positions come from classification, not DOM order.** `src/lib/cards.js` is the heart of
correctness. A search page carries ~190 gig-shaped links for 48 real results: category
tree, filters, pagination, footer, and a recommendations row whose cards are
markup-identical to organic ones. The classifier requires `context_referrer`, excludes
`recommend|promot|sponsor|_ftb_|advert` sources, and then keeps only cards matching the
*dominant* `source` on the page. `position` is the rank **after** filtering — Fiverr
numbers injected cards in its own `data-gig-id="<gigId>_<index>"` sequence too, so
reading its index directly produced the original phantom-duplicate bug (one seller
apparently ranking once per page).

**Every exclusion is counted and surfaced in the UI.** A silent filter is exactly how the
first version shipped wrong numbers for weeks. When the classifier can't explain a gap in
the index run, it warns instead of reporting a number it can't stand behind.

**The PAC script is scoped to Fiverr hosts only** (`src/lib/proxy.js`, `PROXIED_HOSTS`),
with `mandatory: true` so it fails closed rather than leaking to direct. Nobody's banking
session goes through our gateway. There are tests asserting `fiverr.com.evil.net` stays
DIRECT; keep them.

**The gateway checks two things before relaying a byte** (`server/src/proxy/gateway.js`):
a valid short-lived token (15 min, `audience: 'proxy'`), and a Fiverr destination on port
80/443. A relay without both is an open proxy. It is disabled unless
`PROXY_GATEWAY_ENABLED=true`, for the same reason. Upstream proxy credentials never leave
the server — the extension receives a token, never a proxy password.

**`src/lib/entitlements.js` is UI, not enforcement.** It renders quota state. Anyone can
rewrite `chrome.storage` from DevTools. Real gating has to be the server counting checks.
Never add a paid feature whose only gate is extension-side.

## Ruled out: server-side scanning

`server/src/worker/` scans Fiverr with Playwright. **It does not work, and the user has
explicitly said they don't want scraping.** Do not revive it without being asked.

Six configurations were tried: datacentre IP; a residential NZ ISP IP that browses Fiverr
daily unchallenged from a normal browser; headless Chromium; real headful
`google-chrome-stable` under Xvfb; matching locale and timezone; full page loads with
resource blocking off; a patched fingerprint. Page 1 came back exactly once and never
reproducibly. The conclusion is that PerimeterX detects the DevTools Protocol driving the
browser, not the IP — the same IP is fine in a real browser.

The product answer is the current architecture: the scan runs in the user's own browser
tab, and the proxy gateway changes *where* that browser appears to be. That keeps the
per-country feature without a server ever fetching a Fiverr page.

Two related notes, if the worker code is ever touched: `playwright` is pinned to `1.56.1`
to match the container's preinstalled browser build, and `xvfb-run` fails *silently* here
(no output, no error, no exit code) — `docker/with-display.sh` starts Xvfb and waits for
the socket instead.

## Commands

```bash
npm test                      # extension, 57 tests, no setup needed
cd server && npm test         # server, 69 tests (see database setup below)
cd server && npm run gateway  # the CONNECT relay, standalone — no Google/Stripe/DNS needed
cd server && npm run proxy-token   # mints a token and prints two curl commands to verify it
```

The DB-backed tests skip rather than fail without a database, so without one the server
suite reports 62 tests and 1 skipped instead of 69 passing — a green run that is quietly
missing the tracking tests. The container is ephemeral (`node_modules` and any Postgres
cluster are gone after a restart), so the full sequence from scratch is:

```bash
cd server && npm install                       # 28 packages, no browser download
mkdir -p /var/tmp/pgdata && chown postgres:postgres /var/tmp/pgdata
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/tmp/pgdata"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pgdata -l /var/tmp/pg.log -o '-p 5433 -k /tmp' start"
su postgres -c "/usr/lib/postgresql/16/bin/createdb -p 5433 -h /tmp fiverrtracker"
TEST_DATABASE_URL="postgres://postgres@localhost:5433/fiverrtracker" npm test
```

Skip `initdb`/`createdb` if `/var/tmp/pgdata` already exists. Migrations in
`server/src/migrations/` are applied by the tests themselves.

There is no build step and no bundler. `src/` loads directly as an unpacked extension.

`npm run proxy-token` prints two curls. Read both: a `403` from
`https://www.fiverr.com/` with **no curl error** means the tunnel opened correctly and
Fiverr rejected bare curl (expected). `curl: (56) CONNECT tunnel failed, response 403` on
`https://example.com/` is the gateway correctly refusing a non-Fiverr host. Same status
code, opposite meanings — the gateway logs its refusal reason now, so check the log rather
than inferring from the code.

## State

**Verified working:** card classification and positions against a captured real page; sort
selection against live Fiverr; the proxy gateway on the user's VPS (both curls behaved
correctly); all 126 tests.

**Written but never run end-to-end:** sign-in from the extension, plan purchase, and a
scan through a country proxy. Nobody has completed that path once. It is the next real
milestone, and it needs the deployment below.

**Written but not wired up:** `src/lib/tracking.js` — scheduling rules for daily
automated tracking, fully tested, connected to nothing.

**Blocked on the user's consoles, not on code:** DNS `api.rankpeek.app` →
`31.97.48.218`, ports 80/443/8443 open, a Google OAuth client, four Stripe prices plus
Customer Portal and webhook, then `.env` filled from `server/.env.example` and
`docker compose up -d`.

## Open decisions

**The tier split needs settling before anyone pays.** Pro currently has little substance,
because automated daily tracking doesn't exist. Either wire up `src/lib/tracking.js` so
Pro means something, or move country selection down to Pro and make Business about volume.
This is the user's call and was explicitly left to them — don't quietly pick one.

## Secrets and housekeeping

- **`extension-key.pem` is gitignored and must be backed up.** It pins the extension id
  `jnmcfoojlghechjiacmllggbcffclhca` via the manifest `key`. Lose it and Chrome will never
  accept another upload as the same extension.
- **Proxy credentials for the NZ endpoint were pasted in chat and should be rotated.** If
  they still appear anywhere in the repo or in a config, that's a bug.
- **`server/src/legal.js` has placeholders.** `LEGAL_ENTITY` and `JURISDICTION` are
  guesses (`RankPeek` / `Sri Lanka`) and the pages need a real review before launch.
- Fiverr session cookies were considered and rejected: personalised results, plus a real
  ban risk for the user's own account.

## Conventions

- ES modules throughout, Node 22+ on the server, `node --test` with
  `node:assert/strict`. No test framework, no mocking library.
- Tests carry a comment explaining *what regression they exist for* when the reason isn't
  obvious from the name. Several encode bugs that shipped; that context is the point.
- Assertions are exact. A loose `assert.match` once accepted
  `Chrome/Chrome/141.0.0.0` from a user-agent builder and let a real bug through.
- Everything in `src/lib/` is pure and free of `chrome.*` so it can be unit-tested.
  `background.js` and `content.js` hold the impure edges.
- The panel renders; it never owns scan state.

## Environment note

This dev container has no public internet (outbound HTTPS is 403'd except an npm
allowlist). Fiverr, the proxy provider and the user's VPS are all unreachable from here.
Unit tests and fixture-driven tests run fine; **any live verification has to be run by the
user on their VPS**, so write it as a command they can paste and read the output of.
