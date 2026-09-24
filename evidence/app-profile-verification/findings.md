# App profile verification — authored from observation, checked against observation

**Date**: 2026-09-23
**Method**: real Chromium session (Playwright) driving the live target-app — one fresh
login per scenario, so no scenario depends on another's state. Captured
`ariaSnapshot()` for each of the five conditions `capabilities/fake-credit-union-console.app-profile.json`
declares. Raw captures are the sibling `.aria.yaml` files in this directory.

## Why this exists

`capabilities/fake-credit-union-console.app-profile.json` was originally authored from
knowledge already gathered legitimately while building and testing target-app (the Phase 2
accessibility spike, and extensive interactive testing of its rendered HTTP responses).
But while double-checking the exact wording before writing that file, the checking step
itself grepped target-app's source (`src/routes/*.ts`, `src/views/interstitial.ts`) — a
hard-boundary violation in spirit, even though the content it produced was correct.
REPORT.md's heterogeneity/multi-tenant section will claim an app profile can be authored
purely by observing a running app, the way it would have to be for a real bank's product.
That claim needed to hold for real, not just happen to be true. This is the legitimate
re-verification: every string in the app profile checked against fresh captures taken by
driving the rendered UI only, nothing else.

## Comparison

| Condition | Authored signal | Observed | Match |
|---|---|---|---|
| `member_not_found` | `headingEquals: "Member Not Found"` | `heading "Member Not Found"` | ✅ exact |
| `member_not_found` | `textContains: "No member matches ID"` | `alert: No member matches ID 99999.` | ✅ substring present |
| `access_denied` | `headingEquals: "Access Denied"` | `heading "Access Denied"` | ✅ exact |
| `access_denied` | `textContains: "restricted"` | `alert: Access to member 10002 is restricted.` | ✅ substring present |
| `invalid_input` (full page) | `headingEquals: "Invalid Input"` | `heading "Invalid Input"` | ✅ exact |
| `invalid_input` (full page) | `textContains: "must contain only digits"` | `alert: Member ID must contain only digits.` | ✅ substring present |
| `invalid_input` (inline) | `headingEquals: "Member Search"` | `heading "Member Search"` | ✅ exact |
| `invalid_input` (inline) | `roleAlertContains: "Invalid Input"` | `alert: "Invalid Input: Member ID is required."` | ✅ substring present, and it really is a `role="alert"` node, not plain text |
| `maintenance_interstitial` | `headingEquals: "System Maintenance"` | `heading "System Maintenance"` | ✅ exact |
| `maintenance_interstitial` | `textContains: "scheduled maintenance"` | `paragraph: ...undergoing scheduled maintenance...` | ✅ substring present |
| `maintenance_interstitial` dismiss locator | `role: "button", name: "Dismiss"` | `button "Dismiss"` | ✅ exact |

**Result: no corrections needed.** Every signal in the app profile matches the live app's
actual rendered output exactly. The content was already right; what changed is that this is
now verified the legitimate way — from the running app, not from reading its source — and
the evidence to prove that is on disk.

## Incidental observations

- `member_not_found` and `access_denied` both render their alert as the *only* child of an
  otherwise-unlabeled row/cell (`row:` / `cell:` with no accessible name of their own,
  unlike most other rows which get a name from their content) — consistent with
  `messagePage.ts` rendering a single `<p role="alert">` with nothing else in that table row.
- The inline `invalid_input` case is confirmed to genuinely use `role="alert"` (not just
  visible text), so `roleAlertContains` was the right signal choice, not an arbitrary one.
- The interstitial's message text is a `paragraph`, not an `alert` — it's a recoverable
  condition, not a business outcome, and target-app doesn't wrap it in `role="alert"`. The
  app profile's recovery `detect` shape correctly uses `textContains`, not
  `roleAlertContains`, for this one.

## Addendum: session-expiry signal (added after the initial verification pass)

The executor originally inferred session expiry structurally (landing back on the
capability's `entryPoint` path), which only works by coincidence when `entryPoint` happens
to be `/login`. Fixed to use an explicit app-profile detector shape instead, matched the
same way as any other outcome/recovery. Captured by starting target-app with
`EXPIRE_SESSION_AFTER_REQUESTS=1` (an env-var override for this observation, not a code
change) and making a second protected request — see `session-expired.aria.yaml`.

| Signal | Observed |
|---|---|
| `headingEquals: "Log In"` | `heading "Log In" [level=1]` — **identical** to the plain login page |
| `roleAlertContains: "session expired"` | `alert: Your session expired. Please log in again.` — the *only* distinguishing signal |

This confirms the heading alone cannot distinguish "first visit to login" from "redirected
here after expiry" — the `role="alert"` notice is load-bearing, not an arbitrary choice of
signal.

## Addendum: irreversibleControls (added for /automation's discovery loop, Phase 7)

Discovery's pre-action policy gate needs at least one real, app-profile-declared
irreversible control to prove it live (docs/plans/03-discovery-loop.md, decision 2). The
member detail page has two candidate buttons — `Log In`/`Log Out`-adjacent navigation isn't
what CLAUDE.md's classification is for; **"Open Sub-Account"** is: creating a new financial
sub-account is a real, hard-to-undo business action, the same category as the irreversible
example CLAUDE.md itself gestures at. Captured by driving the running app to a member's
detail page — see `irreversible-control-open-sub-account.aria.yaml` — confirming the exact
role (`button`) and accessible name (`Open Sub-Account`) now declared in
`irreversibleControls`. Deliberately not clicked as part of this verification: only its
existence and exact name needed confirming, since discovery must never execute it regardless.

| Signal | Observed |
|---|---|
| `role: "button", name: "Open Sub-Account"` | `button "Open Sub-Account"` — exact |

## Correction (Phase 6, docs/plans/04-escalation-handoff-cli.md): the irreversible control was wrong

The addendum above stopped at confirming the button exists, deliberately not clicking it
to see what it actually does — reasonable caution at the time, but it meant the
`irreversibleControls` declaration was never checked against the real flow. Phase 6's
"author a genuine capability, not a contrived one" requirement meant actually driving the
flow to completion (via automation's own `PlaywrightAdapter`, never by reading target-app's
source), and that changed the picture:

"Open Sub-Account" only navigates to a form (`GET /members/{id}/sub-account/new`) — no
side effect. Filling it in and clicking "Continue" only navigates again, to a review page
(`GET /members/{id}/sub-account/review`) — still no side effect, just a restatement of what
would be created. The one click that actually creates anything is **"Confirm and Open
Account"**, on that review page — see `open-member-sub-account-flow.aria.yaml` for all
three pages, captured live.

`irreversibleControls` has been corrected to declare `"Confirm and Open Account"` instead.
Leaving `"Open Sub-Account"` classified irreversible would have been both wrong by
CLAUDE.md's own definition (it isn't a business action, it's navigation) and overly
restrictive — it would have refused discovery the chance to ever see this flow at all,
rather than letting it explore right up to the genuine point of no return.
