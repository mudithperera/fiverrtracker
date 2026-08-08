# Gauntlet loop — RankPeek polish & region monetization

## Role

You are running a **gauntlet loop** on `mudithperera/fiverrtracker` (RankPeek, an MV3
Chrome extension + Hono/Node backend). A gauntlet loop is bounded adversarial iteration:
each round you make the smallest defensible improvement, then try to break it, then prove
you didn't break anything that already worked. You stop when a full round produces no
finding worth acting on — not when you run out of ideas.

Branch: `claude/fiverr-tracker-extension-improve-hw17ip`. Commit at the end of every
round that lands a change. Never push to another branch.

## The one invariant

**The extension works today. Nothing in this loop may change what it does.**

Concretely, these behaviors are frozen and any round that alters one is a failed round to
be reverted, not a tradeoff to be argued:

- Scanning: the state machine in `src/background.js` drives the tab through sort modes and
  pages; the cursor in `chrome.storage.local` survives worker eviction and resumes.
- Result identification: `src/lib/cards.js` reads `data-gig-id` indices and
  `context_referrer`, buckets everything else, and reports index-run gaps rather than
  papering over them.
- Sort calibration: modes are verified against Fiverr's own sort control on every scanned
  page and badged `actually Relevance` when the parameter stops working.
- Proxy scoping: the PAC script routes **only** `fiverr.com` / `www.fiverr.com`, and the
  proxy setting is cleared when the scan ends. This is a safety property, not a feature —
  widening it is out of bounds under any justification.
- Geo gating: `/proxy/session` refuses without `features.geoTracking`. Server stays the
  authority; the extension never becomes the enforcer.
- `npm test` (root) and `npm test` (server) stay green: 57 + server suites, zero failures.

Refactors are allowed. Behavior changes are not. If you believe a frozen behavior is
wrong, write it down under "Findings for the human" and move on — do not act on it.

## Round protocol

Each round is four phases, in order. Do not skip a phase because the round looks small.

**1. Pick.** State the single highest-value item from the backlog below (or one you found
last round). One item per round. If two look equal, take the one a user would notice first.

**2. Build.** Make the change. Match the surrounding code: this repo comments *why*, not
*what*, and its prose is plain. Keep pure logic pure and DOM-free — that is what makes
`src/lib/*` testable without a browser, and it is worth preserving.

**3. Attack.** Now try to break your own change. Actually run things; do not reason about
them from the armchair:
   - `npm test && (cd server && npm test)` — both must be green.
   - Add tests for the new logic. A round that adds behavior-adjacent code and no test is
     not finished.
   - Walk the failure paths by hand: offline, signed out, expired token, proxy refused
     mid-scan, worker evicted between pages, Fiverr showing a captcha, a country with no
     configured proxy. For each, name what the user sees. "It throws" is a finding.
   - For visual changes: check both themes and the narrow side-panel width (~320px), and
     check focus states and keyboard reachability. The side panel can be dragged narrow —
     a layout that only works at 400px is broken.

**4. Prove.** Show the evidence: test output, and for UI work a description precise enough
that the human can verify it without opening Chrome. Then commit with a message in this
repo's voice — what changed and why it was worth changing, not a changelog line.

## Stop condition

Stop when a full round's Pick phase turns up nothing that clears this bar: *a user or a
maintainer would be materially better off with this than without it.* Polish that no one
would notice is where this loop is supposed to end, not accelerate. State plainly that you
are stopping and why.

Also stop immediately — and ask — if you find yourself wanting to change a frozen behavior
to make something else work.

## Backlog

Ordered by my read of value; re-order if a round proves me wrong.

### Visual
- The side panel is 1331 lines of CSS against a 236-line HTML file. Look for dead rules
  and near-duplicate blocks; consolidate onto tokens without changing rendered output.
  Screenshot-equivalence is the bar — if it looks different, it's a behavior change.
- Scan progress currently reads as log lines. A scan is up to 30 navigations; the panel
  should make "how far along am I" answerable at a glance without reading the log.
- Results are the product. Make the found position the loudest thing in the row, and make
  the `actually Relevance` badge impossible to miss — a wrong-sort result presented like a
  right one is the failure mode with the highest cost.
- Empty, loading, and error states: check each one is actually designed rather than
  defaulted.

### Region system — this is the revenue path
The plumbing exists end to end (picker in `panel.html`, `applyProxy` in `background.js`,
`/proxy/session` + gateway server-side, `geoTracking` on the Business plan). What's thin
is everything around it, and that's what makes it earn:
- **Locked-state selling.** A Business-only feature a free user can't see doesn't convert.
  The country picker should show what they'd get, priced, in one click — not just refuse.
- **Proving it worked.** After a geo scan, the user has no evidence the route was actually
  used. Rankings from Germany that silently came from their own IP are worse than no
  feature. Surface the country the scan actually ran through, sourced from something the
  server confirms — and if the proxy dropped mid-scan, say so loudly rather than reporting
  the numbers.
- **Country availability.** `/proxy/countries` is live; make unavailable countries legible
  in the picker rather than silently absent.
- **Per-country history.** `history` rows already carry `country`. Once geo scans record
  it, the same keyword across countries becomes comparable — that comparison is the thing
  worth paying for, so check whether the shape is there.
- **Failure honesty.** Proxy errors mid-scan already log; verify the scan does not go on
  producing rows attributed to a country it is no longer routing through.

### Technical
- `background.js` (925) and `panel.js` (945) are the two files that will rot first. Extract
  along existing seams only — the split that already exists (worker owns state, panel is a
  pure renderer) is good and should get sharper, not be replaced.
- Error surfaces: audit every `catch`. Any that swallows, or that shows the user a raw
  `message`, is a finding.
- The server's tests cover the pure logic well; the extension's cover `lib/` and nothing
  else. The state machine's resume path is the highest-risk untested code in the repo.

## Findings for the human

Keep a running list at the end of your report: things you decided not to touch, frozen
behaviors you think are wrong, and anything that needs a product decision. Do not act on
these — surface them.
