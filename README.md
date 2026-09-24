# interface-ai-automation

A computer-use automation system: an LLM discovers how to complete a goal in
a real UI that has no API (`/target-app`, a fake credit-union servicing
console), the successful run is recorded as a typed, versioned capability
artifact, and that artifact replays deterministically afterwards with no
model in the decision loop.

This file is setup and the exact demo path. For the design write-up, see
`REPORT.md`. For deeper documentation of `/automation` itself (its file map,
result contracts, what discovery does and doesn't reproduce on its own),
see `automation/README.md`. For how the capability artifacts and app
profile under `/capabilities` were authored, see `capabilities/README.md`.

## Setup

Two independent npm projects, no workspace, no shared code — but every
command below, in both terminals, is a root `npm run` script (`package.json`
delegates via `--prefix`), so there is no `cd` anywhere and the working
directory never changes.

**Terminal 1 — target-app** (the app being driven):

```bash
npm run target-app:install
npm run target-app:env   # copies target-app/.env.example -> target-app/.env (never overwrites an existing one)
```

Fill in `target-app/.env` by hand: `TARGET_APP_USERNAME`, `TARGET_APP_PASSWORD`,
`SESSION_SECRET`. Then:

```bash
npm run target-app:dev   # http://localhost:4000
```

Leave this running.

**Terminal 2 — automation:**

```bash
npm run automation:install
npm run automation:playwright:install
npm run automation:env   # copies automation/.env.example -> automation/.env (never overwrites an existing one)
```

Fill in `automation/.env` by hand: `TARGET_APP_USERNAME`/`TARGET_APP_PASSWORD`
(the **same values** you just put in `target-app/.env`) and, only if you
intend to run `discover`, `ANTHROPIC_API_KEY`.

Everything from here on — the whole demo path below — runs in this same
terminal, still from the repo root.

## Demo path

Every command below is a root `npm run` script, run from the **repo root**,
exactly as written — no `cd` anywhere.

### 1. Replay a capability — deterministic, no model, no human

```bash
npm run replay -- \
  --capability capabilities/lookup-member-savings-balance.artifact.json \
  --app-profile capabilities/fake-credit-union-console.app-profile.json \
  --input memberId=10001
```

Logs in, searches for member `10001`, reads their name and savings balance,
and completes with `success`. Evidence (a redacted JSONL step log, a
human-readable `summary.json`, and a screenshot when the run didn't end
cleanly) is written under `evidence/replay/<timestamp>-lookup_member_savings_balance/`.

### 2. Replay the irreversible flow — stops before acting, on its own

```bash
npm run replay -- \
  --capability capabilities/open-member-sub-account.artifact.json \
  --app-profile capabilities/fake-credit-union-console.app-profile.json \
  --input memberId=10001 \
  --input accountType=money-market \
  --input initialDeposit=500
```

(`accountType` accepts either the option's rendered label, `"Money Market"`,
or its underlying value, `money-market` — Playwright's `selectOption`
matches either. The value form is used here since it needs no shell
quoting, and it's what `evidence/replay/2026-09-24T09-28-15-640Z-open_member_sub_account/`,
the live interactive run cited below, actually used.)

This capability's last step — actually creating the sub-account — is
classified `irreversible`. Without `--allow-irreversible` or `--interactive`,
replay stops right before that click and reports exactly why, rather than
attempting it or guessing:

```
replay: escalated — Step "click-confirm-and-open-account" is classified
irreversible and allowIrreversible was not set on this replay call;
stopping before it is attempted.
```

### 3. Replay it again, with a human in the loop — the escalation handoff

```bash
npm run replay -- \
  --capability capabilities/open-member-sub-account.artifact.json \
  --app-profile capabilities/fake-credit-union-console.app-profile.json \
  --input memberId=10001 \
  --input accountType=money-market \
  --input initialDeposit=500 \
  --interactive
```

A visible browser window opens (headed by default — that's the point, see
"Escalation handoff" below). When automation reaches the confirm step, it
**pauses**, ceding control of that same window, and the terminal prints
everything an operator needs to act: which capability, which step, why it
stopped, the current URL, and a screenshot. Complete the confirmation
yourself in the browser window, then answer the prompt:

```
Your answer (performed / skipped / aborted): performed
```

Automation takes control back, **re-verifies** the page rather than trusting
the answer, and — because the action genuinely happened — completes with
`success`. A real run of exactly this, end to end, is recorded at
`evidence/replay/2026-09-24T09-28-15-640Z-open_member_sub_account/summary.json`
(and its `intervention-1.raw-page-content.png`).

Add `--headless` to any command above to force a headless browser (useful
on a machine with no display — CI, a remote box); `--interactive` still
works, but there's no window for a human to actually act in, so it only
makes sense with `--headless` if you intend to answer `aborted` or `skipped`.

### 4. Discover a capability instead of being told the steps

```bash
npm run discover -- \
  --goal capabilities/lookup-member-savings-balance.goal.json \
  --app-profile capabilities/fake-credit-union-console.app-profile.json \
  --input memberId=10001
```

Drives the same flow via an LLM tool-use loop (click/type/select/read/done/
escalate — see CLAUDE.md's "Discovery loop"), with no script telling it what
to do next. On `done`, the resulting capability artifact is written *inside
this run's own evidence directory* (`evidence/discovery/<timestamp>/capability.artifact.json`)
by default — never into `/capabilities` unasked, so running the demo never
leaves an untracked file in your working tree. Pass `--out <path>` to write
it somewhere specific once you've actually reviewed it. (The committed
`capabilities/lookup-member-savings-balance.artifact.json` is hand-authored,
not discovered — it predates `discover()` entirely. A later discovery run
independently reproduced the same flow from scratch, unprompted; that
comparison — what it got right on its own versus what still needed a human
— is `automation/README.md`'s "What discovery reproduced on its own, and
what it didn't".) Costs real Anthropic API tokens; requires
`ANTHROPIC_API_KEY` in `automation/.env`.

`username`/`password` are resolved automatically from
`TARGET_APP_USERNAME`/`TARGET_APP_PASSWORD` in `automation/.env` whenever a
capability or goal declares an input by exactly that name — no credential is
ever typed on the command line or committed anywhere. Every other declared
input needs its own `--input name=value`.

### 5. Replay the same lookup for a member who doesn't exist — a business outcome, not a failure

```bash
npm run replay -- \
  --capability capabilities/lookup-member-savings-balance.artifact.json \
  --app-profile capabilities/fake-credit-union-console.app-profile.json \
  --input memberId=99999
```

```
replay: business_outcome
```

This is the distinction the brief calls out by name as the most common
design mistake here: a recognized, expected answer (`member_not_found`) is
not the same thing as an error, and this project's result contract keeps
them structurally separate — `business_outcome` is never thrown, never
logged as a failure, never conflated with `failed` (see CLAUDE.md's "Result
contract"). A recorded example of exactly this run is
`evidence/replay/2026-09-23T23-33-06-496Z-lookup_member_savings_balance/summary.json`.

## Escalation handoff

CLAUDE.md's rule: when `replay()`/`discover()` hits something it can't
safely do unattended, a human takes control of **the same live session**,
not a fresh one — automation pauses, cedes control, the human acts, control
comes back, and the run resumes or ends. Who holds control is always
explicit state, not a side effect of where an `await` happens to be
suspended: `automation/escalation.ts`'s `createControlGate` wraps the
`SurfaceAdapter` so every method throws `ControlOwnershipError` while
control is ceded, proven by a direct test (`test/escalation.test.ts`), not
just assumed safe.

The operator's answer is a **closed set** — `performed | skipped | aborted`
for an irreversible-action escalation — never free text; the same lesson
that redesigned the model's own `escalate` tool earlier in this project. And
`performed` is never simply trusted: replay re-runs the exact same
`checkTransition` check it would run after its own action, against the
capability's declared checkpoint. If the operator says `performed` but the
page shows otherwise, the run escalates again with what was expected versus
what was actually observed — it does not silently believe the operator, or
silently succeed. `evidence/replay/2026-09-24T09-28-15-640Z-open_member_sub_account/`
is a real, live run of this whole mechanism, end to end, with the operator
actually completing the confirmation in the browser.

**The scope this implies, named rather than left implicit:** the pause is a
suspended `await` in one Node process. The session lives only as long as
that process runs, the operator has to be at the same machine, and a crash
mid-pause loses the run — `automation/escalation.ts`'s own module doc
comment states this explicitly. In production, an intervention would be
routed to an operator who could be anywhere (a queue, not a direct function
call), and the browser session would need to outlive this process entirely
(a remote or detachable browser context, session persistence, reattachment
from a different process). The operator console here — a terminal prompt,
`automation/consoleEscalationHandler.ts` — is deliberately minimal; the
control-transfer model underneath it is real, not mocked.

## Goal file format (for `discover`)

A goal file (`schema/discoveryGoalFile.ts`) declares what `discover` should
attempt — never a literal input value, only a name and a sensitivity, so
it's always safe to commit:

```json
{
  "capabilityId": "lookup_member_savings_balance",
  "version": "1.0.0",
  "appId": "fake-credit-union-console",
  "description": "Log in, search for a member by ID, and read their savings balance from the Account Balance panel.",
  "entryPoint": "/login",
  "inputs": {
    "username": { "sensitivity": "none" },
    "password": { "sensitivity": "secret" },
    "memberId": { "sensitivity": "pii" }
  },
  "outputs": {
    "memberName": { "sensitivity": "pii" },
    "savingsBalance": { "sensitivity": "pii" }
  }
}
```

(`capabilities/lookup-member-savings-balance.goal.json` is this exact file.)
The CLI resolves each declared input's actual value the same way `replay`
does — `--input name=value`, or the `TARGET_APP_USERNAME`/`PASSWORD`
convenience for those two specific names — and hands `discover()` a fully
literal `DiscoveryGoal` at run time. The goal file itself never carries one.

## `continuesAfterSkip`, for whoever authors a capability

A step's `continuesAfterSkip: boolean` (default `false`, `schema/step.ts`)
only matters for a step classified `irreversible`, and only during an
escalation handoff: if the operator answers `skipped` — the action
deliberately did not happen — replay only continues past that step into the
rest of the capability when `continuesAfterSkip: true` is declared on it;
otherwise the run ends, stating why, rather than risk continuing on an
unmet dependency. There's no step-dependency graph anywhere in this schema,
so "do later steps need this one's effect" can't be inferred — it has to be
declared by a human who has actually read the capability. The last step in
a capability is always safe to skip regardless (nothing downstream could
depend on it), independent of this flag. `open-member-sub-account.artifact.json`
leaves it at the default on its one irreversible step — it's also that
capability's last step, so the flag doesn't change anything there, but
`false` is still the honest, conservative statement for a step nothing has
actually reviewed for downstream dependencies.
