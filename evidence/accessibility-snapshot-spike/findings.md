# Accessibility snapshot spike — findings

**Date**: 2026-09-23
**Method**: real Chromium session (Playwright) driving the live target-app (login → search →
member detail → balance panel), `ariaSnapshot()` captured at each stage plus two targeted
follow-up probes. Raw captures are the sibling `.aria.yaml` files in this directory.

This exists because the Perception Model section of `CLAUDE.md` requires verifying what
Playwright's snapshot actually reports rather than assuming browser heuristics — two of the
three assumptions going into Phase 2 of `docs/plans/02-automation-core.md` turned out wrong.

## 1. `<th scope="row">` → `rowheader` — confirmed, as assumed

Both the member-detail table and the balance panel show it correctly, e.g.:

```yaml
- row "Savings $1,234.56":
  - rowheader "Savings"
  - cell "$1,234.56"
```

## 2. Nested layout tables vs. the data table — assumption was wrong

Expected: Chrome would reclassify the pure-layout wrapper table (target-app's outer
page-frame table, from `renderPage`) as something other than `table`, making it naturally
distinguishable from the real content tables.

Observed: it does not get reclassified. Every table — layout or data — reports as plain
`role="table"` in the snapshot. The outer wrapper renders as a one-row, one-cell table whose
row/cell accessible **name is the concatenation of everything inside it**, e.g.:

```yaml
row "Username Password Log In"
row "Name Elena Cho Member ID 10001 Status active Account Balance Open Sub-Account Log Out"
```

So `table`/`row`/`cell` roles alone cannot distinguish layout from data — a locator strategy
that tried to target "the row named X" generically would be unreliable against the outer
wrapper's giant concatenated name. The only reliable structural signal is the presence of a
`rowheader` cell, which only the real content tables have. The structural locator strategy
already planned (`getByRole('rowheader', { name })`) targets exactly that, so the design
holds — but the "layout tables get filtered out on their own" assumption does not, and the
adapter must not rely on it.

## 3. The iframe — two real surprises

- **The `title` attribute does not surface as the iframe's accessible name.** The main-frame
  snapshot shows a bare `- iframe` node — no name at all — despite
  `title="Account Balance"` being present. Per HTML-AAM the title attribute should
  contribute to the accessible name; empirically, in this Chromium build, it doesn't:
  `page.getByRole('iframe', { name: 'Account Balance' })` finds **zero** matches.
  `page.getByTitle('Account Balance')` finds it correctly (count: 1). Frame targeting
  therefore goes through `frameLocator('iframe[title="..."]')` — a CSS attribute
  selector — not a role+name query. This was already the schema's planned design
  (`FrameRefSchema`); this spike turns it from an assumption into a verified, cited fact.
- **Iframe content is never included in the main page's snapshot.** Confirmed each frame
  needs its own `ariaSnapshot()` call via `frameLocator`, never inherited from the parent.
- **`page.frames()` reported an empty URL for the balance iframe immediately after the
  triggering click** — a timing artifact, not a structural problem. After
  `page.waitForLoadState('networkidle')`, the same frame reports its correct URL
  (`/members/10001/balance`). The adapter's snapshot capture must wait for load state
  before enumerating frames, not read `page.frames()` immediately after an action.
- End-to-end resolution works exactly as designed:
  `frameLocator('iframe[title="Account Balance"]').getByRole('rowheader', { name: 'Savings' })`
  finds exactly 1 match.

## Incidental: YAML quoting

The raw YAML quotes a whole line in single quotes when the underlying text contains a colon
(`'row "Member: Elena Cho"':`), since a bare colon is otherwise significant YAML syntax. A
real YAML parser handles this correctly, but it's a concrete case the snapshot parser's tests
must cover explicitly, not just the doc examples.

## What this changes in the design

- Frame targeting (`schema/frame.ts`'s `FrameRefSchema`, translated by the adapter) is
  confirmed correct and is now evidence-based rather than assumed — see the comment in
  `automation/adapter/playwrightAdapter.ts` at the point it builds the `frameLocator` CSS
  selector.
- The structural locator strategy's reliance on `rowheader` presence (rather than on table
  nesting depth or generic row/cell matching) is confirmed as the right design, not just a
  reasonable one.
- The adapter's snapshot-capture step waits for `networkidle` before enumerating
  `page.frames()`.
