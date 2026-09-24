# REPORT

The model discovers how to do a task once; the artifact it produces is a
reusable capability; deterministic replay is how something else, a script,
an operator, eventually an agent, invokes that capability again with no
model in the loop. Every section below traces back to that split.

## Architecture

Three layers, enforced by what imports what, not just convention.
`adapter/playwrightAdapter.ts` is the only file that imports `playwright`;
`discovery/model.ts` is the only file that imports `@anthropic-ai/sdk`.
The schemas, the app profile, the policy gate, redaction, and both
executors touch neither. `executor/replay.ts` never imports anything from
`discovery/`, so "no model in the replay decision loop" is provable from
the import graph, not merely promised.

The biggest single decision here is perceiving through the accessibility
tree, worth defending directly. A screenshot plus click coordinates can't
replay deterministically: pixel positions depend on window size, scroll,
and zoom, and repairing a broken one needs a model on every replay, exactly
what this design refuses. CSS selectors fail differently: they assume a
DOM at all, which a desktop or non-web surface may not have. The
accessibility tree gives a locator stable across window size and
layout (role plus accessible name, not position), and portable across
surfaces, since the same concepts exist in Windows UI Automation and
macOS's AX API.

The loop that builds an artifact is observe, decide, act, repeated. Each
turn snapshots the accessibility tree, builds a compact per-frame view, and
the model answers with one of six tool calls, picking a ref from that
view; the driver resolves it against its own snapshot and builds the
locator from what it actually observed, never from what the model claims.
There is no free-navigation tool. The loop ends in one of five distinct,
recorded results: goal met, step budget exhausted, time budget exhausted,
several actions with no change (dead end), or the model escalates.

Data is split into three files because each changes on its own schedule. A
**capability artifact** is what one task does. An **app profile** is how
the app behaves everywhere: outcome detectors, recovery rules, the
allowlist, which controls are irreversible. A **tenant overlay** is how
one installation differs: a base URL and control-name overrides. A new
capability never touches the app profile; a new tenant never touches a
capability. `cli.ts` is this demo's human entry point; an agent
orchestrator would call `replay()`/`discover()` directly instead.

## Artifact schema

The schema makes certain mistakes impossible to represent, not just
discouraged in review. A `type`/`select` step's value has exactly one
shape, `{ fromInput: string }`. No literal-value variant exists, so a
runtime value can't be baked into an artifact even by accident, and that
same decision is the PII decision: an artifact that only references
declared inputs by name is automatically safe to commit. Checkpoints are
conditions, never text: `heading_starts_with`, `frame_present`,
`text_contains`. There's no "heading equals this exact string" kind, so a
checkpoint can't pin a member's name into the artifact. The model never
gets a channel to write any of this: `discovery/tools.ts`'s six tools take
only a ref, a declared input or output name, or (for `escalate`) a closed
`reasonCode`, never free text. The model picks which element or which
declared name; the driver builds the locator, derives the checkpoint, and
composes any human-readable text itself.

A locator is a chain of up to four strategies (role and name, label,
structural row-header, CSS or XPath), and every entry requires
`rationale: string`. The two brittle strategies require
`brittle: z.literal(true)` in the schema itself, not a convention someone
could skip. Inputs and outputs each carry a `sensitivity`, which is what
redaction reads. Cross-field integrity is checked at load:
`CapabilityArtifactSchema.superRefine` rejects a step referencing an
undeclared input, a read naming an undeclared output, or a declared output
no step ever writes. `approvalState` is meaningful rather than decorative
because it is always `"draft"` on anything `discover()` emits; nothing in
this codebase can produce `"approved"` except a human editing the file.
`lookup-member-savings-balance.artifact.json` and
`open-member-sub-account.artifact.json` are the two places that happened.

## Determinism & error handling

Determinism doesn't come from a fixed step list. Replay *is* a fixed step
list. It comes from removing every point where a step's outcome would
depend on a judgment call: no model runs during replay, locators resolve
by role and accessible name rather than pixel position, each step's own
`checkpoint` is verified before the next step runs, and every `replay()`
launches a fresh `chromium.launch()`, so no state from a previous run
leaks into the next. Waiting is kept deliberately narrow too. A recovery
fires only on a detected page shape, like the interstitial, never a blind
delay. A per-step `timeoutMs` exists for a slow response with no interim
page at all (target-app's member `10004`); nothing reads that field yet,
a real, named gap (Cuts).

CLAUDE.md warns not to assume browser heuristics and to check what
Playwright's snapshot actually reports; verifying that mattered here. One
assumption tested was that a nested layout table would render differently
from a real data table; it didn't. Every table in
target-app, layout or data, reports plain `role="table"`; the only
reliable signal that a table holds real content is a `rowheader` cell
(`evidence/accessibility-snapshot-spike/findings.md`). The structural
locator strategy already depended on `rowheader` presence anyway, so the
design held, but "layout tables filter themselves out on their own" did
not, and would have broken quietly if left unverified.

The result contract is a four-way union, and the brief names conflating
`business_outcome` with `failed` as the most common mistake here.
`evidence/replay/2026-09-23T23-33-06-496Z-lookup_member_savings_balance/summary.json`
is a real run of memberId `99999`: `"status": "business_outcome"`,
`"outcome": "member_not_found"`, no error class, nothing that looks like a
crash, because it isn't one.

One live finding changed a locator choice directly. The savings-balance and
member-name cells do carry an accessible name, but it's exactly the
rendered value (`"$1,234.56"`), not a stable identifier, so a role-and-name
locator built from it would only ever match this one observed balance. The
fix was structural resolution instead: find the value cell by which row
header sits beside it, the same mechanism `discover()` arrived at
independently, later, unprompted (`automation/README.md`'s
discovery-comparison table).

## Heterogeneity & multi-tenant

Two different kinds of variation, solved two different ways. A new
**surface**, desktop instead of browser, costs one new adapter and nothing
else, because a capability artifact only ever speaks role, accessible
name, and frame, never CSS or a pixel position. The same concepts exist in
Windows UI Automation and macOS's AX API, so the format extends there by
writing a second `SurfaceAdapter`.

Legacy web apps are the other end of the same story, and target-app was
deliberately built to be one: no `data-testid` anywhere, nested tables
used for layout, a balance panel rendered inside an iframe. None of that
changes the design, because the accessibility tree doesn't depend on clean
markup, only on real controls; a frame-heavy, table-laid-out legacy app
still exposes role and accessible name the same way a clean one does. What
would actually break this design is a surface with no accessibility tree
at all, a canvas-rendered UI for instance, out of scope here.

Multi-tenant is a different axis: same app, same surface, different
rendered labels, solved with an overlay, not a second recording.
`translateLocatorChain()` maps a locator's stored name through the overlay
before the adapter sees it. One capability is proven against two tenants,
the default and a beta tenant that renders "Member ID" as "Account
Number".

Drift, a capability or app profile diverging from what the live app
actually does, isn't handled today, but the signal already exists: the
same capability replayed against two tenants, or two versions, either
passes the same checkpoints on both or it doesn't. A checkpoint failure on
one tenant but not the other is the drift signal, since replay already
reports errorClass and expected-versus-observed detail per step. What's
missing is turning a pattern across runs into an alert, rather than a
one-off `failed` result a human has to happen to notice.

Honest exception: `resolveFrameScope()` builds
`page.frameLocator('iframe[title="..."]')` to target the balance panel's
iframe, the one raw selector anywhere in this system, and it lives
entirely inside the adapter. `page.getByRole('iframe', { name })` found
nothing even though the iframe has `title="Account Balance"`; Chromium's
accessibility tree doesn't surface an iframe's `title` as its accessible
name.

## Escalation & handoff

Control transfer is explicit, inspectable state, not an implication of
where an `await` is suspended. `createControlGate()` wraps the
`SurfaceAdapter` and tracks a `ControlOwner: "automation" | "operator"`.
While ownership is `"operator"`, every gated method, including read-only
ones, throws `ControlOwnershipError` instead of running, except `close()`,
since a `finally` releasing the browser has to work regardless of who
holds control. `test/escalation.test.ts` proves every method throws while
ceded and works again once control returns.

The operator's answer is a closed set: `performed`, `skipped`, or
`aborted`, never free text, and `performed` is never simply believed.
`replay()` re-runs the same `checkTransition()` check it would run after
its own action, against the capability's declared checkpoint; a clean pass
resumes, a failure re-escalates with expected-versus-observed detail,
bounded so it can't ask forever.
`evidence/replay/2026-09-24T14-26-24-983Z-open_member_sub_account/summary.json`
is a real run of exactly this: `"status": "success"`, the confirm step's
own line recording `"handledByOperator": true, "operatorSignal": "performed"`
directly. A human completed the confirm step in the same live browser
window automation had been driving, and the run verified the page before
calling it done.

The scope this implies is named, not left implicit. The pause is a
suspended `await` in one Node process: the session lives only as long as
that process runs, the operator has to be at the same machine, and a crash
mid-pause loses the run. Production would need the intervention routed to
an operator who could be anywhere, and a browser session, remote or
detachable, that outlives this process entirely. The console here is
deliberately minimal; the control-transfer model underneath it is real.

## Safety

Several independent layers, each narrow on its own. An allowlist, checked
at every transition before any page content is read. Steps classified
`safe` or `irreversible`, defaulting to stop rather than proceed. A
six-tool surface where nothing carries a locator, a checkpoint, or a
literal value. Redaction at two layers: declared field sensitivity at
capture, and a second value-based scrub that catches a known secret
wherever it appears. And an operator's `performed` claim, verified against
the page, never trusted on its word.

None of that makes "never persist PII" absolute. A screenshot captures
whatever is on screen, member names included, and no text redaction
touches image bytes. This narrows that channel as far as it goes: only
failure or escalation captures one, each named `*.raw-page-content.png` so
a reviewer can tell which files need different handling. It's still a
real exception, and production would need access control and a retention
policy on the evidence directory because of it. One file isn't even that
careful: `consoleEscalationHandler.ts`'s own operator-viewing copy, written
to the OS temp directory, is never cleaned up.

Discovery sends the redacted page view to the model provider every turn,
real page content leaving the process, which is why this system belongs
against sandbox data and why replay never calls a model at all. Password
fields aren't structurally distinguishable from a plain textbox in the
accessibility tree either, one more reason the DOM's own `type` attribute
was deliberately never read: that would cross the accessibility-tree-only
perception boundary this project holds everywhere else.

The allowlist checks *where* an action happens, never *what* it does. That
list got something wrong once, live: an earlier pass declared "Open
Sub-Account" irreversible after confirming only that the button exists,
never driving what it does. It's plain navigation; nothing is created
until "Confirm and Open Account," two pages later
(`evidence/app-profile-verification/open-member-sub-account-flow.aria.yaml`).
A second finding in the same spirit: the discovery model's `escalate`
reason was free text, and a live run had it quote a member's name verbatim
into evidence. The fix wasn't a filter; it was removing the free-text
channel entirely, so `escalate` now takes a closed `reasonCode` plus an
optional ref, the same shape every other tool argument already had.

## Cuts

Left out, on purpose:

- A real graphical or web operator console. The terminal prompt is real,
  not mocked, but it's the minimum the brief allows.
- A browser session that outlives the process, for handoff across
  machines, and adapters for desktop or legacy surfaces beyond the one
  Playwright adapter that exists; the seam is built for more than one.
- Multi-tenant infrastructure beyond the overlay mechanism itself, and
  drift detection turned into an actual alert (see Heterogeneity).
- Per-step checkpoints from a discovered artifact, a structural gap in the
  `done` tool, which can only prove the final state, not an oversight.
- More than one `businessOutcomes` entry from discovery, since one run
  only proves the one path it took.
- An approval gate that actually blocks unattended replay of a `"draft"`
  artifact. The field exists everywhere; nothing reads it yet.
- Falling back to an LLM when replay fails, rejected on principle: "no
  model in the replay decision loop" is the property this design protects.
- An agent-facing capability catalogue a caller could query by intent
  rather than file path, and any database, queue, or auth system beyond
  the dummy login target-app already has.

Persistence is deliberately flat files, not a database, because the brief
says scaling infrastructure isn't rewarded. The seams that would make it
replaceable already exist: `schema/loader.ts` separates loading from
validation behind one function per artifact type, so a registry could swap
in without `replay()`, `discover()`, or the schemas changing; `evidence.ts`
is called explicitly after a run rather than baked into either executor,
which is why object storage plus a metadata index could replace flat files
the same way.

Next: the approval gate first, since the field is already there and wired
for nothing. Then the agent-facing catalogue, since the CLI is a demo
harness for a human, not what an agent would call. Then a detachable
browser session, the one real, current limitation in the escalation model.
