# RankPeek

A Chrome extension that finds where a Fiverr gig ranks for a keyword — across **all
three** of Fiverr's sort orders (Relevance, Best Selling, New Arrivals), not just the
default one.

## Why it works this way

Two constraints shaped the design, both verified rather than assumed:

- **Fiverr returns HTTP 403 to server-side requests.** The scan has to run inside the
  user's own logged-in browser tab. There is no server-side shortcut.
- **Fiverr's sort URL parameter is undocumented and its CSS class names are hashed.**
  Anything hardcoded here breaks silently and reports "gig not found" forever. So the
  extension *calibrates* against the live site instead of guessing (see below).
- **Most gig-shaped links on a search page are not search results.** A typical page
  carries ~190 of them for 48 actual results: the category tree, filter dropdowns,
  pagination, the footer, and a *recommendations row* whose cards look identical to real
  ones. Counting links is therefore not a way to count rankings — see below.

## How a result is identified

Positions come from Fiverr's own markup rather than from counting DOM nodes:

- Each result card carries `data-gig-id="<gigId>_<index>"`. **Fiverr numbers its own
  results**, so position is a value we read, not one we infer. The indices on a page
  should run `0..47`; if they don't, the extension says so instead of reporting numbers
  it can't stand behind.
- Real result links carry a `context_referrer` query parameter. Page furniture carries
  none, which is what separates the 48 from the other ~140.
- Injected modules (recommendations, promoted placements) carry their own `source`, while
  organic cards echo the `source` of the page URL. That comparison is self-calibrating,
  so it keeps working across pages that were reached differently.

Everything excluded is counted and shown in the panel by bucket — `4
recommendation_ftb_friendly` — because a silent filter is exactly how the previous
version reported a seller ranking once on every page.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select this repository's root folder.
4. Click the extension's toolbar icon to open the side panel.

## First run: calibrate

Open the panel's **⚙ settings** and press **Recalibrate sort modes** once.

This navigates to a Fiverr search page, reads the sort control, and records which query
parameters each sort option actually sets — reading them off the options' `href`s if
possible, otherwise opening the dropdown, clicking each option, and diffing the resulting
URL. The result is cached and reused.

Each mode is then **verified against Fiverr's own sort control**, which displays the
active sort. This matters because a parameter Fiverr *ignores* still returns a perfectly
normal-looking page — it is just Relevance wearing another name. Comparing result sets is
not enough to catch it, since Fiverr reorders between loads anyway; the control is the
only ground truth. The same check runs on **every scanned page**, so a mode whose
parameter stops working is badged `actually Relevance` in the results instead of
reporting numbers that look fine.

Fiverr's sort parameter is `filter` (`auto` / `rating` / `new`, observed 2026-07). Those
are the built-in defaults, so the extension works before calibration — but they are
treated as guesses until the sort control confirms them.

If something looks wrong, **Diagnose page reading** in settings dumps what the content
script actually sees on the page — card count, index run, exclusion buckets, sort control
labels — as copyable JSON.

## Usage

Enter a keyword and a Fiverr username, pick which sort orders to scan, then press
**Start**. The extension drives the tab through each sort mode's pages and reports, per
sort mode, the page and position where the gig was found.

**Click any result** to open the page it was found on with that gig outlined. That is the
intended way to trust the numbers — rather than taking a reported position on faith, look
at the gig sitting at it. (Pause a running scan first; it is driving the same tab.)

The username field accepts `@handle`, `handle`, `fiverr.com/handle`, or a full gig URL —
all normalize to the same thing. (Comparing a typed `@handle` straight against Fiverr's
URLs is a common source of false "not found" results.)

**Stop** pauses and keeps the cursor; **Resume** carries on from the same sort mode and
page. If Fiverr shows a human-verification check, the scan pauses and asks you to solve
it, then resumes from where it stopped.

## Architecture

```
manifest.json           MV3
src/background.js       Service worker — the scan state machine (start here)
src/content.js          Injected on Fiverr pages; dumb DOM scraper + sort calibration
src/panel.{html,css,js} UI — a pure renderer, holds no scan state
src/lib/cards.js        Which cards are real results, and why the rest were dropped (pure)
src/lib/sortmodes.js    Sort-mode definitions, URL building, calibration cache
src/lib/extract.js      Gig-link parsing, username normalization, matching (all pure)
src/lib/scan-state.js   Scan record, resume cursor, serialized persistence
src/lib/history.js      Completed-scan history, per (keyword, username, country)
src/lib/entitlements.js Plan/quota gating — renders what the server decided
src/lib/api.js          The API client; every quota and billing answer comes through here
src/lib/proxy.js        Country picker states, PAC script, gateway session settings (pure)
src/lib/review.js       When to ask for a store review (pure)
server/                 API, Stripe billing, and the per-country proxy gateway
```

The scan state machine lives in the **service worker**, not the UI. A scan drives up to
30 navigations; every one of them destroys the content script, the panel can be closed at
any time, and MV3 can evict the worker. The cursor is written to `chrome.storage.local`
after every page, and the worker resumes from it on wake.

Termination is handled explicitly rather than by always walking N pages: the scan stops a
sort mode early when results run out, and detects Fiverr **clamping an out-of-range page
number** back to the last real page by fingerprinting each page's gigs — otherwise the
last page's gigs would appear to rank on every remaining page.

## Tests

```
npm test
```

Covers the pure logic: username normalization, gig-path parsing, result classification,
position arithmetic, URL building, calibration diffing, cursor advancement, scan progress,
country-picker states, and what history is allowed to record about a country.

`cd server && npm test` covers the server: plan maths, entitlement derivation, proxy
endpoint parsing, token verification, and rate limiting.

`test/cards.test.js` is built from a real captured page — 48 organic results plus a
4-card recommendations row carrying its own colliding `0..3` index sequence — and asserts
the row is bucketed rather than counted, that an unknown future `source` is excluded and
flagged rather than silently counted, and that a gap in the index run is reported instead
of being papered over.

## Accounts and plans

Sign-in is Google OAuth; the extension never sees a password. Quota is decided by the
server, not the panel: `/scans/permission` is asked before a scan and `/scans/complete`
after one, and the server re-derives the allowance from its own usage table.
`src/lib/entitlements.js` renders that answer and caches the last one so the panel has
something to draw offline — it is not the gate.

Signed-out users get a small local allowance so the extension is usable before anyone
creates an account. That allowance *is* trivially bypassable from DevTools, which is
exactly why it is small and why every paid feature requires a session.

Billing is Stripe Checkout, with plan state driven by webhooks rather than by what the
client claims. Only intervals with a configured Stripe price are advertised — offering one
that then fails at checkout is worse than not offering it.

## Scanning from another country

Rankings differ by country, and this is the paid feature. Pick a country on the checker
and the extension routes **only Fiverr** through a proxy in that country for the duration
of the scan.

The scan itself still runs in the user's own browser — that constraint has not moved, and
server-side scanning stays defeated by the 403 above. Only the route changes.

Three things make that defensible rather than reckless:

- **Scope.** `chrome.proxy` is a browser-wide setting, so a PAC script narrows it to
  Fiverr's hosts and nothing else, and it is cleared the moment the scan ends. Pushing
  somebody's banking session through a third-party proxy would be indefensible.
- **No silent fallback.** The PAC script is `mandatory`. A scan that quietly went direct
  would report the user's own rankings as another country's — wrong in a way nobody could
  detect afterwards. If the route dies, the scan fails instead.
- **Credentials stay on the server.** The extension holds a short-lived token naming the
  customer and country; the gateway swaps it for the real upstream proxy. Extension
  storage is readable by whoever is running it.

History rows record the country the scan was **actually routed through** —
`scan.routedCountry`, written only once the proxy is in force, never the country that was
merely asked for. `trendFor` treats country as part of a series' identity, so the same
keyword in two countries is two lines rather than one line that swings when the route
changes.

## Not yet built

- **Daily automatic tracking.** Both the keyword tracker and the competitor tracker need a
  scheduler that does not exist yet. The plan cards say "coming soon" on those lines until
  it ships; `server/src/plans.js` is where that marker lives.
- **A headless scanner behind the proxies.** Per-country scanning is on demand today — the
  user presses Start. Running one every morning without a browser open needs the worker in
  `server/src/worker/`, which is why a plain HTTP client will not do (see the 403 above).
