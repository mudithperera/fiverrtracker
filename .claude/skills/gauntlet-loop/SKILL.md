---
name: gauntlet-loop
description: Run bounded adversarial iteration on working code — rounds of pick one improvement, build it, attack it, prove nothing regressed — until a round turns up nothing worth doing. Use when asked to run a gauntlet, gauntlet-loop, or to iteratively polish something that already works without breaking it.
---

# Gauntlet loop

Bounded adversarial iteration on code that **already works**. The loop's purpose is to
raise quality without spending the thing you already have.

The failure this guards against is the one that makes iterative polish dangerous: an agent
improving working code until it no longer works, one defensible step at a time.

## Before the first round

Establish the baseline and write it down:

1. Run the full test suite. Record the exact pass count. This is the number every
   subsequent round must reproduce.
2. List the **frozen behaviors** — what this code does that must not change. Be specific
   and observable ("the cursor resumes after worker eviction"), not vague ("scanning
   works"). Include safety properties explicitly; they are the ones most easily traded
   away for a feature.
3. Build the backlog, ordered by whether a user or maintainer would be materially better
   off. Cosmetic items go at the bottom or get cut.

If the baseline is already red, stop and say so. A gauntlet cannot protect what is already
broken.

## The round

Four phases, in order. Do not skip one because the round looks small.

**1. Pick** — one item, stated out loud, with why it is the highest-value item now. One
item per round; a round that touches three things cannot be reverted cleanly when phase 3
finds a problem.

**2. Build** — the smallest change that fully does the thing. Match the surrounding code's
idiom, comment density, and naming. Refactors are allowed; behavior changes to frozen
items are not.

**3. Attack** — try to break what you just built. Run things; do not reason from the
armchair.
   - Full suite green, same count or higher.
   - New logic gets tests. Behavior-adjacent code with no test is an unfinished round.
   - Walk the failure paths by hand and name what the user sees in each. "It throws" is a
     finding, not an outcome.
   - For UI: narrow widths, both themes, keyboard reachability, focus states.

**4. Prove** — show evidence: real test output, and for UI a description precise enough to
verify without running it. Then commit. One round, one commit.

A round that fails phase 3 is reverted, not argued down. Reverting is cheap because
phase 1 kept the round to one item.

## Stopping

Stop when a round's Pick phase turns up nothing clearing the bar: *someone is materially
better off with this than without it.* Polish nobody would notice is where the loop ends,
not where it speeds up.

Stop and ask when you want to change a frozen behavior to make something else work. That
tension is a product decision, not an implementation detail.

State plainly that you are stopping and why. A loop that runs out of budget mid-round
should say which round it was on and what it had not yet proven.

## Reporting

Keep two running lists across all rounds:

- **Landed** — one line per round: what changed and the evidence.
- **Findings for the human** — what you chose not to touch, frozen behaviors you think are
  wrong, and anything needing a product decision. Surface these; do not act on them.

The second list is the more valuable of the two. An agent that iterates without surfacing
what it declined to do has hidden its judgment calls.
