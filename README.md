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
  extension *calibrates* against the live site instead of guessing (see below), and it
  identifies gigs by their `/username/gig-slug` link path rather than by class names.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select this repository's root folder.
4. Click the extension's toolbar icon to open the side panel.

## First run: calibrate

Open the panel's **⚙ settings** and press **Recalibrate sort modes** once.

This navigates to a Fiverr search page, reads the sort control, and records which query
parameters each sort option actually sets — reading them off the options' `href`s if
possible, otherwise clicking each option and diffing the resulting URL. The result is
cached and reused.

If calibration fails, the extension falls back to built-in guesses **and shows a warning
banner**, so a wrong guess is never silently reported as "not found". Re-run it if Best
Selling or New Arrivals start looking wrong; it also auto-flags itself as stale after 30
days.

## Usage

Enter a keyword and a Fiverr username, pick which sort orders to scan, then press
**Start**. The extension drives the tab through each sort mode's pages and reports, per
sort mode, the page and position where the gig was found.

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

Covers the pure logic: username normalization, gig-path parsing, card dedup and ordering,
position arithmetic, URL building, calibration diffing, and cursor advancement.

## Not yet built

- **Real accounts and billing.** `src/lib/entitlements.js` is local-only and therefore
  **not enforcement** — anyone can rewrite `chrome.storage` from DevTools. It renders the
  quota UI and gives the future backend one place to hook into. Real gating requires the
  server to count checks.
- **Per-country daily tracking.** Needs a backend: a daily scheduler, per-country
  residential proxies, and a headless browser behind each one (a plain HTTP client will
  not work — see the 403 above). History rows already carry a `country` field, always
  `null` today, so the geo data lands on the same shape without a migration.
