# Fiverr Gig Ranking Tracker

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

Each mode is then **verified**: the extension loads it and checks it returns a different
first page than Relevance. This matters because a parameter Fiverr *ignores* produces
identical results, which is indistinguishable from a working sort unless you look — an
ignored parameter silently turns "Best Selling" into a second copy of "Relevance". Modes
that can't be verified are labelled `unverified` in settings and badged next to their
results, so a guess is never presented as a measurement.

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
src/lib/history.js      Completed-scan history
src/lib/entitlements.js Plan/quota gating — the single seam for a future backend
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
position arithmetic, URL building, calibration diffing, and cursor advancement.

`test/cards.test.js` is built from a real captured page — 48 organic results plus a
4-card recommendations row carrying its own colliding `0..3` index sequence — and asserts
the row is bucketed rather than counted, that an unknown future `source` is excluded and
flagged rather than silently counted, and that a gap in the index run is reported instead
of being papered over.

## Not yet built

- **Real accounts and billing.** `src/lib/entitlements.js` is local-only and therefore
  **not enforcement** — anyone can rewrite `chrome.storage` from DevTools. It renders the
  quota UI and gives the future backend one place to hook into. Real gating requires the
  server to count checks.
- **Per-country daily tracking.** Needs a backend: a daily scheduler, per-country
  residential proxies, and a headless browser behind each one (a plain HTTP client will
  not work — see the 403 above). History rows already carry a `country` field, always
  `null` today, so the geo data lands on the same shape without a migration.
