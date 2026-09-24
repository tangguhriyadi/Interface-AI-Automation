# REPORT

The model discovers how to do a task once; the artifact it produces is a reusable
capability; deterministic replay is how something else (a script, an operator,
eventually an agent) invokes that capability again with no model in the loop.
Every section below traces back to that split.

## Architecture

Three layers, enforced by what imports what, not just convention.
`automation/adapter/playwrightAdapter.ts` is the only file that imports `playwright`;
`automation/discovery/model.ts` is the only file that imports `@anthropic-ai/sdk`.
Everything else, including the schemas, the app profile, the policy gate,
redaction, and both executors, touches neither. That gives a structural fact, not a
claim: `executor/replay.ts` never imports anything from `discovery/`, so "no model
in the replay decision loop" is provable from the import graph, not merely
promised.

The middle layer is `discover()` and `replay()`. Both read a `Snapshot`, a parsed
accessibility tree with stable per-frame refs (`adapter/snapshotParser.ts`), shared
by checkpoint evaluation, outcome/recovery matching, and locator resolution alike:
one tree-walking implementation rather than two that could drift. Building that
snapshot layer meant checking assumptions against the real app rather than trusting
documentation, exactly the rule CLAUDE.md states directly: do not assume browser
heuristics, verify what Playwright's snapshot actually reports before depending on
it. The assumption tested here was that a nested layout table would render
differently from a real data table; it did not hold. Every table in target-app,
layout or data, reports plain `role="table"`; the only reliable signal that a table
holds real content is whether it has a `rowheader` cell at all
(`evidence/accessibility-snapshot-spike/findings.md`, "assumption was wrong"). The
structural locator strategy already depended on `rowheader` presence anyway, so the
design held, but "layout tables filter themselves out on their own" did not, and
would have broken quietly if left unverified.

Data is split into three files because each changes on its own schedule. A
**capability artifact** is what one task does: steps, inputs, outputs, its own
checkpoint. An **app profile** is how the app behaves everywhere: outcome
detectors, recovery rules, the allowlist, which controls are irreversible. A
**tenant overlay** is how one installation differs: a base URL and control-name
overrides. A new capability never touches the app profile; a new tenant never
touches a capability; the app profile changes only when the vendor's shared
behavior changes, which is rare and app-wide, never per-task.

The CLI (`automation/cli.ts`, hand-rolled argument parsing, no framework) is the
human entry point for this demo, thin against `discover.ts` and `replay.ts`. The
real production caller isn't a terminal: `replay()` and `discover()` are plain
async functions with no CLI dependency, callable directly by whatever orchestrates
an agent's tool calls.

## Artifact schema

The schema makes certain mistakes impossible to represent, not just discouraged in
review. A `type`/`select` step's value has exactly one shape, `{ fromInput: string }`
(`schema/step.ts`); no literal-value variant exists in the type, so a runtime value
can't be baked into an artifact even by accident. That one type decision is also the
PII decision: an artifact that can only reference declared inputs by name is
automatically safe to commit and reusable across memberIds. Checkpoints are
conditions, never text: `heading_starts_with`, `frame_present`, `text_contains`
(`schema/checkpoint.ts`); there is no "heading equals this exact string" kind, so a
checkpoint can't pin a specific member's name into the artifact.

The model never gets a channel to write any of this. `discovery/tools.ts`'s six
tools take only a ref, a declared input/output name, or (for `escalate`) a closed
`reasonCode`; no argument anywhere is free text. The model picks which element or
which declared name; the driver builds the locator, derives the checkpoint, and
composes any human-readable text itself.

A locator is a chain of up to four strategies (role+name, label, structural
row-header, CSS/XPath), and every entry requires `rationale: string`; Zod rejects
one without it. The two brittle strategies require `brittle: z.literal(true)` in
the schema itself, not a convention someone could skip. Inputs and outputs each
carry `sensitivity: "secret" | "pii" | "none"`, which is what redaction reads
(Safety). Cross-field integrity is checked at load: `CapabilityArtifactSchema.superRefine`
rejects a step referencing an undeclared input, a read naming an undeclared output,
or a declared output no step ever writes: the typo that would otherwise produce a
quietly "successful" replay missing a field. `approvalState` is meaningful rather
than decorative because it is *always* `"draft"` on anything `discover()` emits;
nothing in this codebase can produce `"approved"` except a human editing the file.
`lookup-member-savings-balance.artifact.json` and `open-member-sub-account.artifact.json`
are the two places that actually happened.

## Determinism & error handling

Determinism doesn't come from a fixed step list; replay *is* a fixed step list. It
comes from removing every point where a step's outcome would depend on a judgment
call: no model runs during replay; locators resolve by role and accessible name, not
pixel position; a recovery fires only on a detected page shape, never a blind delay;
each step's own `checkpoint` is verified before the next step runs, never assumed
from a successful click; and every `replay()` launches a fresh `chromium.launch()`,
so no state from a previous run leaks into the next.

Two things wait for the app, kept deliberately separate. A recovery rule
(`appProfile.recoveries[].action.kind === "wait"`) fires when a detectable page
shape matches and waits a declared duration: the interstitial case, something the
snapshot can see. `step.ts` separately declares a per-step `timeoutMs` for the
opposite case, a slow response with no interim page at all (target-app's member
`10004`). Worth being precise: the recovery-rule wait is wired and exercised
(`executor/appDetection.ts`); the per-step field is declared and schema-validated,
but nothing in the adapter reads it yet to extend an action's own wait. A real,
named gap, covered in Cuts.

The result contract is a four-way union, and the brief names conflating
`business_outcome` with `failed` as the most common mistake here.
`evidence/replay/2026-09-23T23-33-06-496Z-lookup_member_savings_balance/summary.json`
is a real run of memberId `99999`: `"status": "business_outcome"`, `"outcome": "member_not_found"`;
no error class, nothing that looks like a crash, because it isn't one.

One live finding changed a locator choice directly. Re-verifying against the
running app showed the savings-balance and member-name cells *do* carry an
accessible name, but it's exactly the rendered value (`"$1,234.56"`), not a stable
identifier. A role+name locator built from that would only ever match this one
observed balance and break on every other member. The fix was structural resolution
instead: find the value cell by which row header sits beside it (`"Savings"`,
`"Name"`), the same mechanism `discover()` independently arrived at later,
unprompted, with the same reasoning (`automation/README.md`'s discovery-comparison
table).

## Heterogeneity & multi-tenant

Two different kinds of variation, solved two different ways. A new **surface**,
desktop instead of browser, costs one new adapter and nothing else, because a
capability artifact only ever speaks role, accessible name, and frame, never CSS or
a pixel position. Those concepts exist in a browser's accessibility tree, in
Windows UI Automation, and in macOS's AX API alike, so the same artifact format
extends there by writing a second `SurfaceAdapter`; schemas, `replay()`, and
`discover()` wouldn't change.

Multi-tenant is a different axis: same app, same surface, different rendered
labels, solved with an overlay, not a second recording. One capability is proven
against two tenants: the default, and the beta tenant, which renders "Member ID" as
"Account Number" (`fake-credit-union-console.beta.tenant-overlay.json`).
`translateLocatorChain()` maps a locator's stored name through the overlay before
the adapter sees it, and the allowlist's origin resolves to the overlay's own
`baseUrl` when supplied. `test/integration/lookupMemberSavingsBalance.test.ts` has a
dedicated beta-tenant case, run against target-app restarted with `TENANT=beta` at
that exact URL.

Honest exception: `resolveFrameScope()` in `playwrightAdapter.ts` builds
`page.frameLocator('iframe[title="..."]')` to target the balance panel's iframe,
the one raw selector anywhere in this system; it lives entirely inside the
adapter, never in a schema or an artifact. It's there because
`page.getByRole('iframe', { name })` found nothing even though the iframe has
`title="Account Balance"`; Chromium's computed accessibility tree doesn't surface
an iframe's `title` as its accessible name. Found by trying the role-based call
against the live app and watching it fail, recorded in
`evidence/accessibility-snapshot-spike/findings.md`. `schema/frame.ts` still stores
a structured `{ by: "title", value }`, never the selector; only this one function
knows what a browser needs to do with it.

## Escalation & handoff

Control transfer is explicit, inspectable state, not an implication of where an
`await` is suspended. `escalation.ts`'s `createControlGate()` wraps whatever
`SurfaceAdapter` was given and tracks a `ControlOwner: "automation" | "operator"`.
While ownership is `"operator"`, every gated method (`goto`, `click`, `type`,
`select`, `read`, `snapshot`, `lastNavigationStatus`, `screenshot`, including the
read-only ones) throws `ControlOwnershipError` instead of running; only `close()`
is exempt, since a `finally` that releases the browser has to work regardless of
who holds control. `test/escalation.test.ts` proves every gated method throws
while ceded and works again once control returns.

The operator's answer is a closed set, resolved through `consoleEscalationHandler.ts`'s
real prompt on real stdin: `performed`, `skipped`, or `aborted`, never free text.
`performed` is never simply believed: `replay()` re-runs the exact same
`checkTransition()` check it would run after its own action, against the
capability's declared checkpoint; a clean pass resumes, a failure re-escalates with
expected-versus-observed detail, bounded so it can't ask forever.
`evidence/replay/2026-09-24T14-26-24-983Z-open_member_sub_account/summary.json` is a
real run of exactly this: `"status": "success"`, the confirm step's own line
recording `"handledByOperator": true, "operatorSignal": "performed"` directly (not
just in the `interventions` array), and an `interventions` entry showing
`"decision": { "signal": "performed" }`. A human completed the confirm step in the
same live browser window automation had been driving, and the run verified the
page before calling it done.

The scope this implies is named, not left implicit. The pause is a suspended
`await` in one Node process (`escalation.ts`'s own module comment says this
directly): the session lives only as long as that process runs, the operator has to
be at the same machine, and a crash mid-pause loses the run. Production would need
the intervention routed to an operator who could be anywhere (a queue, not a direct
function call) and a browser session that outlives this process: a remote or
detachable context, persisted and reattachable. The console here is deliberately
minimal; the control-transfer model underneath it is what's real.

## Safety

Several independent layers, each narrow on its own. An allowlist, checked at every
transition during both discovery and replay, before any page content is read.
Steps classified `safe` or `irreversible`, defaulting conservatively: without
`allowIrreversible` or an escalation handler, an irreversible step stops before
it's attempted, never after. A six-tool surface where nothing carries a locator, a
checkpoint, or a literal value. Redaction at two layers: by declared field
sensitivity at capture, and a second value-based scrub that catches a known secret
or PII value wherever it appears, not just in the field it was expected in. And an
operator's `performed` claim, verified against the page, never trusted on its word.

None of that makes "never persist PII" absolute, and the limit is worth stating
plainly. A screenshot captures whatever is on screen, member names included, and no
amount of text redaction touches image bytes. This narrows that channel as far as
it goes: a screenshot is only captured on failure or escalation, never a clean
success, and every screenshot file is named `*.raw-page-content.png` specifically so
a reviewer can tell which files need different handling without opening them. It's
still a real exception to the redaction rule everywhere else, and production would
need access control and a retention policy on the evidence directory because of it.
One place this isn't even that careful: `consoleEscalationHandler.ts` writes an
operator-viewing copy of the escalation screenshot to the OS temp directory, and
nothing in this codebase ever deletes it; it relies entirely on the OS's own
housekeeping.

Discovery sends the redacted, ref-based page view to the model provider every turn:
real page content leaving the process, which is why this system belongs against
sandbox data, and why replay never calls a model at all. Checking live whether a
password field is structurally distinguishable from a plain textbox found that it
isn't: `ariaSnapshot()` carries no `type`/masking attribute, and a filled password
field parses as plain `textbox "Password": <the literal value>`. Reading the DOM
`type` attribute directly would fix that, and was rejected on purpose: it would
cross the accessibility-tree-only perception boundary this project holds everywhere
else, the same boundary that makes "swap one adapter for a desktop AX API" a
credible claim rather than a hopeful one.

The allowlist checks *where* an action happens (origin and route prefix), never
*what* it does; the allowlist schema has no action-type dimension at all. And the
irreversible-control list got this wrong once, live: an earlier pass declared "Open
Sub-Account" irreversible after confirming only that the button exists, never
driving what it does. It's plain navigation to a form; nothing is created until
"Confirm and Open Account," two pages later. Found only by driving the flow to
completion, corrected in the app profile, recorded in
`evidence/app-profile-verification/open-member-sub-account-flow.aria.yaml` and that
directory's `findings.md`. A second finding in the same spirit: the discovery
model's `escalate` reason was free text, and a live run had it quote a member's name
verbatim into evidence. The fix wasn't a redaction filter; it was removing the
free-text channel entirely. `escalate` now takes a closed `reasonCode` plus an
optional ref, the same shape every other tool argument already had.

## Cuts

Left out, on purpose: a real graphical or web operator console (the terminal
prompt is genuinely real, not mocked, but it's the minimum the brief allows, not a
console); a browser session that outlives the process, needed for handoff across
machines; adapters for desktop or legacy surfaces (the seam is built for one, only
the Playwright adapter exists); multi-tenant infrastructure (routing, provisioning)
and drift detection for a live app diverging from its profile; per-step checkpoints
from a discovered artifact (not an oversight, a structural gap in the `done` tool,
which can only prove the final state, never an intermediate one); more than one
`businessOutcomes` entry from discovery (one run only proves the one path it took);
an approval gate that actually blocks unattended replay of a `"draft"` artifact
(the field exists and is set correctly everywhere, nothing reads it yet); falling
back to an LLM when replay fails (rejected on principle, not just unbuilt, since
"no model in the replay decision loop" is the property this design protects, not a
gap to patch); an agent-facing capability catalogue a caller could query by intent
rather than file path; and any database, queue, or auth system beyond the dummy
login target-app already has.

Persistence specifically is deliberately flat files, capability artifacts under
`/capabilities`, evidence under `/evidence`, not a database or object store,
because the brief says scaling infrastructure isn't rewarded and building it
before anything needs it isn't either. The seams that make it replaceable without
touching the core already exist, though, rather than being something a later
rewrite would have to invent. `schema/loader.ts` separates loading (`readJson`, a
plain file read) from validation (the Zod schema) behind one function per artifact
type: `loadCapability`, `loadAppProfile`, and so on. A capability registry
(versioning, approval history, per-tenant access) could swap in behind that same
function without `replay()`, `discover()`, or the schemas changing at all.
`evidence.ts` is called explicitly after a run completes rather than baked into
`replay()`/`discover()` themselves; both stay pure, with no filesystem I/O of
their own, by `evidence.ts`'s own design. That is exactly why object storage plus
a metadata index could replace flat files the same way, behind the same entry
point. Evidence is also where flat files fall short in a way that isn't just
structural: it needs a retention policy in production, and a repo directory
doesn't give you one, the same gap Safety already names for screenshots
specifically (raw page content, no expiry, no access control), just true of the
evidence directory as a whole, not only the image files inside it.

Next: the approval gate first, since the field is already there and wired for
nothing; replay refusing to run an unreviewed artifact unattended is the
highest-value, lowest-effort step. Then the agent-facing catalogue, since the CLI is
a demo harness for a human, not what an agent would actually call. Then a detachable
browser session, the one piece of the escalation model this report names as a real,
current limitation rather than a stylistic choice.
