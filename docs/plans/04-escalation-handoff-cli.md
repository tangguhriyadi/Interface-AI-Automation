# Plan: Escalation handoff + CLI

**Source**: conversational request (no PRD)
**Selected scope**: the human-in-the-loop control-transfer mechanism for both `replay()` and `discover()`, enforced control ownership on the adapter, and the two-command CLI. The operator surface is a minimal console prompt — real input, real pause, real resumption of the same session, not a mocked decision.
**Complexity**: Large

## Summary

Right now, reaching an escalation point in `replay()` or `discover()` is terminal — the function returns `{status: "escalated", ...}` and stops. This plan makes that pausable: an optional `onEscalation` handler, when supplied, is awaited at every existing escalation point *before* returning — the same live `SurfaceAdapter`/browser session stays open throughout, real JS call-stack suspension is the pause. While control is ceded, the adapter itself refuses every operation — an enforced invariant, not an implication of where the `await` happens. The handler receives an `InterventionRequest` (capability/goal, current step or turn, reason, URL, a screenshot captured at that instant) and returns a closed-set `InterventionDecision`, never free text. Automation resumes correctly according to that decision — verifying, never trusting. A minimal console handler is the default "operator surface," and a two-command CLI (`discover`, `replay`) wires everything together, demonstrated against a genuine irreversible flow already in target-app — opening a member's sub-account — not a synthetic one.

## Design decisions

1. **Pause is a suspended `await`, not a generator or state machine — and that's a real seam this plan names, not hides.** `onEscalation: (req: InterventionRequest) => Promise<InterventionDecision>` is an optional field on `ReplayOptions`/`DiscoverOptions`, awaited in place at each escalation point. This is genuinely correct for what's being built, but it has a boundary worth stating plainly: **the session lives only as long as this Node process, the operator has to be on the same machine, and a crash mid-pause loses the run.** In production, an intervention request would be routed to an operator who might be anywhere — a queue, not a direct function call — and the browser session would need to outlive this process (a remote/detachable browser context, session persistence, reattachment on a different process). The brief allows the operator console itself to be mocked; it judges the control-transfer *model*. This plan builds a real, working instance of that model at single-process scope and documents the production-scale seam explicitly rather than leaving it implied by the implementation.

2. **Control ownership is enforced by the adapter itself, not implied by where the await sits.** A new `createControlGatedAdapter(adapter)` wraps any `SurfaceAdapter` with explicit `ControlOwner` state (`"automation" | "operator"`) and guards *every* method — `goto`, `click`, `type`, `select`, `read`, `snapshot`, `screenshot`, `lastNavigationStatus`, `close` — throwing a clear `ControlOwnershipError` if called while ownership is `"operator"`. Read-only methods are gated too, deliberately: even an observation could reflect a mid-action, inconsistent page state while a human is acting, and the invariant should be absolute, not "everything except the calls that seemed harmless." `replay()`/`discover()` wrap the adapter they're given internally (no signature change) and use the wrapped version for every operation of their own; the handoff logic calls `cedeControl()`/`returnControl()` around the `await onEscalation(...)` call. This makes "who is in control" a real, inspectable, testable fact the brief asks for — not a side effect of scheduling.

3. **The decision is a closed set, gated by request kind — not one universal shape.** Only an escalation that's actually *about an irreversible action* (replay's two points; discovery's `action_refused_irreversible` reasonCode) offers `performed | skipped | aborted`. Every other discovery escalation (`stuck`, `unexpected_state`, `cannot_complete`, `recovery_exhausted`, `recovery_action_failed`) offers `resolved | aborted` — there is no action to have performed or skipped. `InterventionRequest.kind: "irreversible_action" | "other"` says which set applies; the dispatcher rejects a decision that doesn't match. Nothing here is free text — the same lesson the `escalate` redesign already established, applied to the human side of the same channel.

4. **`performed` triggers real verification, never trust.** For replay: after `performed`, the loop runs the exact same `checkTransition()` call it would run after executing the step itself. A clean pass records the step and continues; a failure re-escalates through the same `classify()`/terminal-outcome machinery already in place (an irreversible step's failure always escalates) — recursively, bounded by a small retry cap (mirroring the recovery loop's own bounded-retry pattern). Nothing new is invented for the "expected vs. observed" reporting — it's the same fields every other failure in this codebase already uses.

5. **`skipped` requires a human-authored safety declaration, not an inference.** The artifact schema has no step-dependency graph, so "do later steps depend on this" can't be computed — it has to be declared. New field: `continuesAfterSkip: z.boolean().default(false)` on `step.ts`'s `baseStepFields`, same conservative-default shape as `allowIrreversible`. `skipped` continues only when the step is the capability's last step (nothing could depend on it) or `continuesAfterSkip` is explicitly `true`; otherwise the run ends stating why, by construction.

6. **Discovery's verification is honestly weaker than replay's, and the plan says so rather than overclaiming it.** Replay has a declared, artifact-authored checkpoint to check `performed` against. Discovery has no equivalent per-action expectation — it's exploring, not executing a script. Its `performed`/`resolved` handling is: re-snapshot, feed the fresh state to the model's next turn, let the model itself judge whether the action visibly succeeded. A real, structural asymmetry, stated plainly, not smoothed over.

7. **`StepRecord`/`DiscoveryResult` record who did what, not just that something happened.** `StepRecord` gains `handledByOperator?: boolean` and `operatorSignal?: "performed" | "skipped"`. Both result types gain `interventions: InterventionRecord[]` (mirroring how `recoveries`/`durationMs`/`knownSensitiveValues` were each added incrementally before) — each entry carries the request, the decision, and both timestamps.

8. **The operator surface is minimal but the mechanism is real.** A `consoleEscalationHandler` (built on `node:readline/promises`, no new dependency) prints the request and blocks on real stdin for one of the valid closed-set answers, reprompting on anything else. `PlaywrightAdapter.launch()` gains a `{ headless?: boolean }` option (default `true`, preserving every existing test unchanged) — the CLI's commands launch headed by default so the same window a person can click in is the one automation was just driving.

9. **CLI input handling keeps credentials out of shell history and out of committed files.** A new goal-file format (`schema/discoveryGoalFile.ts`) declares each input's `sensitivity` and an `envVar` name — never a literal — resolved from `process.env` at CLI runtime. `replay`'s CLI command takes `--input name=value` for non-secret parameters and requires `--input-env name=ENV_VAR` specifically for any `secret`/`pii`-sensitivity input.

10. **The Phase 6 demo uses the real irreversible flow already in this repo, not a synthetic one.** `capabilities/fake-credit-union-console.app-profile.json` already declares `"Open Sub-Account"` irreversible (from the discovery-loop plan's Phase 7). This plan hand-authors a real `open-member-sub-account.artifact.json` capability around that actual flow — login, search, click "Open Sub-Account," a confirm step classified `irreversible` — and Phase 6 opens with live exploration of target-app's confirm screen (control names, what "confirmed" looks like) before writing it, the same observe-first discipline every other app-profile/capability claim in this project has followed. Requires target-app running; not started, stopped, or restarted by this work.

## Patterns to mirror

| Category | Source | Pattern |
|---|---|---|
| Optional, additive options | `ReplayOptions`/`DiscoverOptions` | `onEscalation` follows the exact shape `allowIrreversible`/`recoveryLimits` already established: optional, default-off, behavior-preserving when absent |
| Shared detection, not two implementations | `executor/appDetection.ts`, `executor/policy.ts` | `InterventionRequest`/`Record` types, `isValidDecisionFor()`, and `createControlGatedAdapter()` live in one new shared module both executors import |
| Bounded retry | `executor/replay.ts`'s recovery loop (`perRuleLimit`/`overallLimit`) | The intervention retry cap follows the same shape |
| Incremental result-shape growth | `recoveries`, `durationMs`, `knownSensitiveValues` each added to `ReplayResultCommon`/`DiscoveryResultCommon` in earlier phases | `interventions: InterventionRecord[]` added the same way, to both |
| Test doubles | `FakeAdapter`, `FakeModel` | A scripted `FakeEscalationHandler` test double queues decisions the same way |
| Conservative, human-declared safety defaults | `allowIrreversible` (default `false`), `irreversibleControls` (default `[]`) | `continuesAfterSkip` (default `false`) |
| Live-verify before authoring | `capabilities/fake-credit-union-console.app-profile.json`'s provenance discipline, `evidence/app-profile-verification/` | The sub-account confirm flow is observed live before `open-member-sub-account.artifact.json` is written |

## Files to change

| File | Action | Why |
|---|---|---|
| `automation/escalation.ts` | **new** | `InterventionRequest`, `InterventionDecision`, `InterventionRecord`, `EscalationHandler` type, `isValidDecisionFor()`, `ControlOwner`, `ControlOwnershipError`, `createControlGatedAdapter()`, `consoleEscalationHandler` |
| `automation/schema/step.ts` | update | `continuesAfterSkip` on `baseStepFields` |
| `automation/executor/replay.ts` | update | wraps its adapter via `createControlGatedAdapter`; `onEscalation` option; both escalation points route through the handoff; `checkTransition` gains a `checkStepCheckpoint` toggle for the post-skip general-safety recheck |
| `automation/discovery/discover.ts` | update | wraps its adapter via `createControlGatedAdapter`; `onEscalation` option; the three escalation points route through the handoff |
| `automation/adapter/playwrightAdapter.ts`, `surfaceAdapter.ts` (types only) | update | `launch(baseUrl, { headless? })` |
| `automation/evidence.ts` | update | writes each intervention's screenshot + the `interventions` array into `summary.json`/JSONL |
| `capabilities/open-member-sub-account.artifact.json` | **new** | the real irreversible-flow capability Phase 6 demonstrates against |
| `automation/schema/discoveryGoalFile.ts` | **new** | the CLI's goal-file format + env-var-resolving loader |
| `automation/cli.ts` | **new** | `discover`/`replay` subcommands (`node:util` `parseArgs`) |
| `automation/package.json`, root `package.json` | update | `discover`/`replay` scripts, matching the existing `automation:*` launcher convention |
| `automation/README.md` | update | exact demo invocations, goal-file format, handoff explainer, `continuesAfterSkip` for artifact authors, the production-scale seam from decision 1 |
| `automation/test/**` | new/updated | coverage per phase below |

## Phases

**Phase 1 — Control-transfer types, enforced ownership, schema.** `escalation.ts`'s types, `isValidDecisionFor()`, `createControlGatedAdapter()`; `continuesAfterSkip` added to `step.ts`. *Validate*: schema tests for the new field; `isValidDecisionFor` tests covering both request kinds and rejecting a mismatched signal; **the control-gating test the brief asks for** — a gated `FakeAdapter` with control ceded throws `ControlOwnershipError` on every single method (`goto`/`click`/`type`/`select`/`read`/`snapshot`/`screenshot`/`lastNavigationStatus`/`close`), and every one succeeds normally again once control returns.

**Phase 2 — Wire into `replay()`.** `onEscalation` option; a shared internal `attemptHandoff()` used by both existing escalation points, sequenced correctly around the gate (capture the screenshot/URL *before* ceding control, since the gated adapter refuses `screenshot()` once ceded); `checkTransition`'s new `checkStepCheckpoint` parameter; `StepRecord.handledByOperator`/`operatorSignal`; `ReplayResultCommon.interventions`. *Validate*: `performed` then a clean re-check continues; `performed` then a failing re-check re-escalates, bounded; `skipped` on the last step always continues; `skipped` on a non-last step without `continuesAfterSkip` ends the run stating why; `skipped` with `continuesAfterSkip: true` continues; `aborted` ends the run; a scripted `FakeEscalationHandler` whose decision arrives *before* asserting the adapter is gated, proving the sequencing; **the full existing 25-test suite passes unchanged with no handler configured**.

**Phase 3 — Wire into `discover()`.** `onEscalation` option; all three escalation points (`recovery_exhausted`, `recovery_action_failed` → kind `"other"`; the model's `escalate` → kind depends on `reasonCode`). *Validate*: `resolved` re-observes and continues the loop; `performed`/`skipped` on an `action_refused_irreversible` escalation re-observe and hand the fresh state to the next model turn (the stated verification asymmetry, tested as such); `aborted` ends the run; **the full existing discovery suite passes unchanged with no handler configured**.

**Phase 4 — Evidence.** `evidence.ts` writes one screenshot file per intervention (captured live, not deferred) plus the run's own end-of-run screenshot when applicable; `summary.json`'s `interventions` array. *Validate*: an intervention's screenshot and redacted request/decision land in both `summary.json` and the JSONL.

**Phase 5 — Minimal operator surface.** `consoleEscalationHandler` (real stdin/stdout, reprompts on an invalid answer, only accepts the valid closed set for the request's kind); `PlaywrightAdapter.launch()`'s `headless` option. *Validate*: a scripted-stdin test proves reprompting on garbage input.

**Phase 6 — The real irreversible flow, and the CLI.**
- **First**: live-explore target-app's sub-account flow (confirm screen control names, resulting state) — needs target-app running; I'll ask if it isn't. Author `open-member-sub-account.artifact.json` from that observation, saved evidence the same way `irreversible-control-open-sub-account.aria.yaml` was.
- `schema/discoveryGoalFile.ts` + loader; `cli.ts`'s `discover`/`replay` subcommands; package.json scripts.
- *Validate*: `discover` on a real live run writes an artifact to `capabilities/`; `replay` runs the hand-authored `lookup-member-savings-balance` artifact end to end via the CLI; **`replay` on `open-member-sub-account.artifact.json`, live, with no `--allow-irreversible`, stops at the confirm step, a human completes it in the same visible window, types `performed`, and the run verifies and completes** — the genuine demo the brief asks for, not a contrived one.

**Phase 7 — Docs.** README: the exact CLI invocations as the demo path, the goal-file format, what `continuesAfterSkip` means to an artifact author, the production-scale seam named in design decision 1, a short "escalation handoff" explainer.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Non-headless Playwright needs a display; fails in a pure headless CI environment | Medium | `headless` defaults to `true` everywhere except the CLI's own commands; not part of the automated test suite |
| Discovery's weaker verification could be read as equivalent to replay's strict check | Medium | Stated explicitly (decision 6), tested as such, documented as such |
| Intervention retry loops forever against a genuinely broken situation | Low | Bounded cap, same shape as the existing recovery-loop bound |
| `continuesAfterSkip` touches `step.ts`, an earlier "done" file | Low | Purely additive, default-`false`; full existing suite re-run to prove no regression |
| The sub-account confirm flow's actual UI is unknown until explored live | Medium | Phase 6 opens with that exploration before any artifact is written; if the real flow doesn't cleanly fit a single "confirm" step, the plan adapts to what's actually there rather than forcing it |

## Acceptance
- [ ] No escalation point changes behavior when `onEscalation` is unset — both full existing suites pass unmodified
- [ ] While control is ceded, every adapter method throws `ControlOwnershipError`, proven by a direct test — not just assumed safe because nothing calls it
- [ ] `performed` is always verified via the same `checkTransition`/`classify` machinery every other check in this codebase uses — never trusted
- [ ] `skipped` past a non-last step is refused unless the step explicitly declares `continuesAfterSkip: true`
- [ ] The decision set is closed and kind-gated; no free text anywhere in the handoff protocol
- [ ] `StepRecord`/`DiscoveryResult` evidence shows who handled a step and which signal they gave
- [ ] The console handler is a real pause on real stdin against the same live browser session, demonstrated live against the real `open-member-sub-account` flow, not a synthetic one
- [ ] The CLI's two exact commands (with real flags) are what README.md documents as the demo path
- [ ] README states the single-process/same-machine seam from design decision 1 explicitly
