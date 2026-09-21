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
/src/             the automation system
/target-app/      the fake servicing console the agent drives
/capabilities/    emitted artifacts
```

`/REPORT.md` headings are fixed and must appear exactly: Architecture,
Artifact schema, Determinism & error handling, Heterogeneity & multi-tenant,
Escalation & handoff, Safety, Cuts.

## The hard boundary

`/src/` must never import from, read the source of, or query the internals of
`/target-app/`. No shared types, no shared fixtures, no reaching into its JSON
data. The target app is a black box that happens to live in the same repo — it
stands in for a bank application whose code we would never have.

The only permitted coupling is through the UI, plus environment variables that
configure the target app's own failure injection when a test sets them up.

If a task seems to require crossing this line, the design is wrong. Say so.

## Perception model

The agent perceives through the **accessibility tree**, not raw HTML. It reads
controls as role + accessible name + value. Screenshots are captured as
evidence and as escalation context — never as the basis for deciding an action,
and never as pixel coordinates to click.

This is deliberate: role/name targeting replays deterministically, and the same
concept exists in Windows UI Automation and macOS AX API, so the design extends
to desktop surfaces by swapping one adapter.

Locators are stored as a chain, tried in order at replay:

1. role + accessible name
2. label text
3. structural position (e.g. row whose first cell matches)
4. CSS/XPath — last resort, must be flagged `brittle: true`

Every locator chain carries a `rationale` string explaining the choice.

## Result contract

Replay returns a discriminated union. Conflating these is the single most
common design mistake in this problem, so keep them strictly separate:

- `success` — goal reached, declared outputs returned.
- `business_outcome` — a legitimate answer the caller needs (`member_not_found`,
  `access_denied`). Declared in the artifact ahead of time. NOT an error, never
  thrown, never logged as a failure.
- `escalated` — cannot safely proceed; an intervention request was raised.
- `failed` — hard failure with step id, locator used, expected vs observed,
  and an error class.

Recoverable conditions (dismissable interstitial, transient slow load) are
handled in-flight and never surface as a result status, but they MUST be
recorded and summarised as `recoveries: string[]` so the reviewer can see they
were detected rather than accidentally skipped.

## Artifact rules

- `schemaVersion` and a capability `version` are mandatory.
- Steps reference inputs by name (`{ fromInput: "memberId" }`). Never bake a
  literal runtime value into an artifact — it breaks parameterisation and
  persists PII.
- `recoveries` are global rules checked at every transition, not per-step
  properties. An interstitial can appear anywhere.
- The target is identified by `appId` (the vendor product), never by tenant.
  Tenant differences live in a separate overlay: base URL plus control-name
  overrides. Artifacts are never re-recorded per tenant.
- Every artifact declares a `successCheckpoint`. Never assume a click worked.

## Safety

- An explicit allowlist of domains, routes, and action types. The agent must
  not act outside it, during discovery or replay.
- Steps are classified `safe` or `irreversible`. The default policy for
  `irreversible` is to stop and escalate to a human, not to proceed. This is a
  conservative choice and is justified in REPORT.md.
- Never persist credentials, tokens, session cookies, or full PII into
  artifacts, logs, or evidence. Redact at the point of capture, not afterwards.
- Test credentials come from environment variables. No secrets in the repo.

## Escalation

A human takes control of **the same live session**, not a fresh one. The
automation pauses, cedes control, the human acts, control is handed back, and
the run resumes. Who holds control is always explicit state.

The operator console may be minimal or mocked — the handoff mechanism and the
control-transfer model must be real. Record what the human did as evidence.

## Working style

- `/plan` first. I review and edit the plan before implementation starts.
- Then `tdd-workflow`: failing test first, then implement.
- Then `/code-review` from fresh context.
- Test where it counts: the artifact schema, the replay executor, the error
  taxonomy, the allowlist. Do not chase a coverage percentage.
- Keep functions readable over clever. I have to defend every line in an
  interview.
- When something is cut or stubbed, it must be intentional, documented, and
  cut at a clean seam. Add it to the Cuts section as you go.

## Out of scope

Real bank systems (never attempt access), multi-tenant plumbing, desktop
implementation, a real co-browsing console, authentication beyond a dummy
login, a real database. These are design answers in REPORT.md, not code.