# CLAUDE.md

Project rules for this repository. These are decisions I have already made.
Follow them. If a plan or an implementation would contradict anything here,
stop and say so instead of working around it.

## What this project is

A computer-use automation system: an LLM discovers how to complete a goal in a
real UI that has no API, the successful run is recorded as a typed, versioned
capability artifact, and that artifact replays deterministically afterwards
with no model in the decision loop.

Take-home assignment for interface.ai. Evaluated on judgment and integration,
not feature breadth. A thin-but-real version of every core requirement beats a
polished subset.

## Stack

- TypeScript on Node, ESM, strict mode.
- Playwright as the driver.
- Anthropic API for discovery. Model configurable via env, default
  `claude-sonnet-5`. The API key lives only in `.env`, never in code or logs.
- Zod for artifact schemas — the schema is validated at load time, not assumed.
- Vitest for tests.
- One CLI with two commands: `discover` and `replay`.

Do not add frameworks, queues, databases, Docker, or a web UI. Scaling
infrastructure is explicitly not rewarded. Simpler is better if justified.

## Repository layout

```
/README.md        setup + exact demo commands
/REPORT.md        design write-up, seven fixed headings (see below)
/evidence/        artifact + logs from a discovery run and replay runs
/src/             the automation system (its own npm project)
/target-app/      the fake servicing console the agent drives (done)
/capabilities/    emitted artifacts, app profiles, tenant overlays
```

`/src` and `/target-app` are two independent npm projects with their own
`package.json`. No workspaces.

`/target-app` is finished and tested. Do not modify it while building `/src`
unless I explicitly ask — if `/src` seems to need a change there, stop and
say so.

`/REPORT.md` headings are fixed and must appear exactly: Architecture,
Artifact schema, Determinism & error handling, Heterogeneity & multi-tenant,
Escalation & handoff, Safety, Cuts.

## The hard boundary

`/src/` must never import from, read the source of, or query the internals of
`/target-app/`. No shared types, no shared fixtures, no reading its JSON data,
no hitting its routes with plain HTTP to shortcut the UI. The target app is a
black box that happens to live in the same repo — it stands in for a bank
application whose code we would never have.

The only permitted coupling is through the rendered UI, plus environment
variables that configure the target app's own failure injection when a test
or demo sets them up.

If a task seems to require crossing this line, the design is wrong. Say so.

## Perception model

The agent perceives through the **accessibility tree**, not raw HTML. It reads
controls as role + accessible name + value. Screenshots are captured as
evidence and as escalation context — never as the basis for deciding an action,
and never as pixel coordinates to click.

This is deliberate: role/name targeting replays deterministically, and the same
concept exists in Windows UI Automation and macOS AX API, so the design extends
to desktop surfaces by swapping one adapter.

Keep a clean seam between the surface adapter (how we perceive and act on a
surface) and everything else (the recorded flow, policy, replay logic). Only
the adapter may import Playwright.

Frames are explicit. Content inside an iframe is a separate document; a step
that targets it names its frame. Never assume a flat page.

Do not assume browser heuristics. Chrome classifies nested layout tables as
`LayoutTable` and data tables as `table`; verify what Playwright's snapshot
actually reports before depending on it.

Locators are stored as a chain, tried in order at replay:

1. role + accessible name
2. label text
3. structural position (e.g. row whose row header matches)
4. CSS/XPath — last resort, must be flagged `brittle: true`

Every locator chain carries a `rationale` string explaining the choice.

## Discovery loop

The model chooses **which element**; the system builds the locator. This is
the rule that keeps artifacts decoupled from the model transcript.

- Each turn, the system snapshots the accessibility tree, assigns a temporary
  ref to each interactive or readable element, and sends a compact, redacted
  view to the model.
- The model answers only through structured tool calls with a deliberately
  narrow set: click, type, select, read (into a named output), done, escalate.
  No free navigation to arbitrary URLs.
- The system resolves the ref against its own snapshot and builds the locator
  chain from observed role, name, label, and structure. The model never
  writes selectors.
- Inputs are declared at discovery time (e.g. `memberId=10001`). When the
  model types a value equal to a declared input, the recorder stores
  `{ fromInput: "memberId" }`, never the literal.
- Every action passes the policy gate before execution (see Safety).
- Stop conditions: goal done, max steps, timeout, dead end (several actions
  in a row with no change in the snapshot), or the model escalates. Each ends
  in a distinct, recorded result.

## Result contract

Replay returns a discriminated union. Conflating these is the single most
common design mistake in this problem, so keep them strictly separate:

- `success` — goal reached, declared outputs returned.
- `business_outcome` — a legitimate answer the caller needs (`member_not_found`,
  `access_denied`). Declared ahead of time. NOT an error, never thrown, never
  logged as a failure.
- `escalated` — cannot safely proceed; an intervention request was raised.
- `failed` — hard failure with step id, locator used, expected vs observed,
  and an error class.

Recoverable conditions (dismissable interstitial, transient slow load) are
handled in-flight and never surface as a result status, but they MUST be
recorded and summarised as `recoveries: string[]` so the reviewer can see they
were detected rather than accidentally skipped.

## Artifact rules

- `schemaVersion` and a capability `version` are mandatory.
- Steps reference inputs by name. Never bake a literal runtime value into an
  artifact — it breaks parameterisation and persists PII.
- Checkpoints are conditions, not text snapshots. "Heading starts with
  `Member:`" or "frame named `Account Balance` is present" — never "heading
  equals `Member: Elena Cho`". A literal checkpoint breaks the next input and
  stores PII.
- Every artifact declares a `successCheckpoint`. Never assume a click worked.
- The target is identified by `appId` (the vendor product), never by tenant.

## App profiles and tenant overlays

Business-outcome detectors and recovery rules are properties of the app, not
of one capability: "Member Not Found" and the maintenance interstitial look
the same everywhere in the app. They live in an **app profile** per `appId`,
authored and reviewed by a human. A capability references the outcomes that
apply to it rather than redeclaring them.

- Recovery rules are global and checked at every transition — an interstitial
  can appear anywhere.
- Outcome detection must not rely on one signal. Match heading, visible text,
  and `role="alert"` where present, but never assume `role="alert"` exists —
  real legacy apps often render errors as plain text.
- The same condition can appear in different shapes in one app (a full page
  titled "Invalid Input" vs an inline alert on the search page). Detectors
  must cover both.

Tenant differences live in a separate **overlay**: base URL plus control-name
overrides (e.g. `Member ID` → `Account Number`). Artifacts are never
re-recorded per tenant.

## Safety

- An explicit allowlist of domains, routes, and action types, enforced during
  discovery **and** replay. The agent must not act outside it.
- Steps are classified `safe` or `irreversible`. The default for
  `irreversible` is to stop and escalate to a human, not to proceed.
- **Never auto-retry an irreversible step.** Retries are for safe steps only.
- **An irreversible step with an ambiguous result escalates.** If the action
  was sent but the success checkpoint never appeared (session expired, error,
  timeout), the effect may already have happened. Do not treat "no success
  page" as "nothing happened". Escalate with evidence.
- Never persist credentials, tokens, session cookies, or full PII into
  artifacts, logs, or evidence. Redact at the point of capture, not
  afterwards. This includes page titles and headings — they often contain
  member names.
- Minimise what reaches the model: redact sensitive values from the snapshot
  sent during discovery unless the task cannot be completed without them.
  Replay never calls the model, so production data never leaves.
- Test credentials and the API key come from environment variables. No
  secrets in the repo.

## Escalation

A human takes control of **the same live session**, not a fresh one. The
automation pauses, cedes control, the human acts, control is handed back, and
the run resumes. Who holds control is always explicit state.

The operator console may be minimal or mocked — the handoff mechanism and the
control-transfer model must be real. Record what the human did as evidence.

## Working style

- `/plan` first. I review and edit the plan before implementation starts.
- Implement phase by phase and stop after each phase for review.
- Then `tdd-workflow`: failing test first, then implement.
- Then `/code-review` from fresh context.
- Test where it counts: the artifact schema, the replay executor, the error
  taxonomy, the policy gate, redaction. Do not chase a coverage percentage.
- Keep functions readable over clever. I have to defend every line in an
  interview.
- When something is cut or stubbed, it must be intentional, documented, and
  cut at a clean seam. Add it to the Cuts section as you go.

## Out of scope

Real bank systems (never attempt access), multi-tenant plumbing, desktop
implementation, a real co-browsing console, authentication beyond a dummy
login, a real database. These are design answers in REPORT.md, not code.