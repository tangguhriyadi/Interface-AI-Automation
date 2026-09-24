# automation

The core of the computer-use automation system: typed capability artifacts, a
Playwright-backed surface adapter, a deterministic replay executor, and an
LLM-driven discovery loop that emits new capability artifacts by actually
driving the app. This project has no knowledge of `/target-app` beyond its
rendered UI — see "The hard boundary" in the repo root `CLAUDE.md`.

Not yet included (a later plan): the escalation/handoff mechanism (a human
taking control of the *same live session* discovery paused, not a fresh one)
and the `discover`/`replay` CLI. Right now this project is a library,
exercised directly from its test suite and, for live runs, from short scripts
— see "Running discovery" below.

## Setup

```bash
npm install
npx playwright install chromium
```

Then create `automation/.env` (never committed — see `.gitignore`) from
`.env.example`:

```bash
cp .env.example .env
```

Fill in:

| Variable | Required | Meaning |
|---|---|---|
| `TARGET_APP_BASE_URL` | yes | Base URL of a running target-app instance, e.g. `http://localhost:4000`. This project never starts target-app itself — start it separately (`/target-app/README.md`). |
| `TARGET_APP_USERNAME` | yes | Test operator username. Must match the value target-app itself was configured with. This project never reads target-app's `.env` — type the same value into both by hand, the way a human operator who happens to know both credentials would. |
| `TARGET_APP_PASSWORD` | yes | Test operator password. Same rule as above. |
| `TARGET_APP_BETA_BASE_URL` | no | Only for the beta-tenant scenario. Leave unset for normal runs — see "Testing the beta tenant" below. |
| `ANTHROPIC_API_KEY` | only for discovery | Your own key ([console.anthropic.com](https://console.anthropic.com/)) — never logged, never written to evidence. Not needed for `npm test` or `npm run test:integration`'s replay scenarios; only for a live `discover()` run (see "Running discovery" below). |
| `DISCOVERY_MODEL` | no | Which model `discover()` drives the tool-use loop with. Defaults to `claude-sonnet-5` when unset. |

No credential ever needs to be read from, or written into, anything under
`/target-app`.

## Testing

Two tiers, deliberately kept separate:

```bash
npm run build             # tsc --noEmit
npm test                  # fast unit suite — no .env, no browser, no target-app
npm run test:integration  # live suite — needs .env and a running target-app
```

`npm test` runs everything except `test/integration/` against a scripted
`FakeAdapter` (queued snapshots, no real browser). It's the suite to run on
every change; it never touches the network.

`npm run test:integration` drives a real Chromium instance against a real
target-app over `TARGET_APP_BASE_URL`. Start target-app first:

```bash
# in a separate terminal, from the repo root
npm run target-app:dev
```

It replays the hand-written `capabilities/lookup-member-savings-balance.artifact.json`
end to end and checks:

- `10001` → `success`, with the correct `memberName` and `savingsBalance` outputs, no recoveries fired
- `99999` → `business_outcome: "member_not_found"`
- `10003` → `success`, with `recoveries: ["maintenance_interstitial"]` recorded — the dismissable interstitial is detected and cleared in-flight
- on every scenario, the password never appears anywhere in the result (`JSON.stringify(result)` is asserted not to contain it)

### Testing the beta tenant

The fourth scenario (`10001` against the beta tenant, proving the tenant
overlay's control-name translation) is skipped unless `TARGET_APP_BETA_BASE_URL`
is set — deliberately not "always on," since a stale value fails loudly
instead of silently skipping. To run it:

1. Stop target-app.
2. Restart it with `TENANT=beta` on the **same** host/port
   `capabilities/fake-credit-union-console.beta.tenant-overlay.json` declares
   as its `baseUrl` (one target-app process serves one tenant; you switch
   tenants by restarting it, not by running two instances at once).
3. Set `TARGET_APP_BETA_BASE_URL` in `.env` to that same URL.
4. Run `npm run test:integration`.
5. Revert: stop target-app, unset `TARGET_APP_BETA_BASE_URL`, restart
   target-app normally.

The allowlist checks the tenant overlay's *declared* `baseUrl`, not whatever
port target-app happens to be listening on — a mismatch fails with a clear
`allowlist_violation` rather than silently passing against the wrong tenant.

## Running discovery

There's no `discover` CLI yet (a later plan). A live discovery run is driven
from a short script, the same pattern used to validate every piece of this
project live before it was called done — see `discovery/discover.ts`'s own
doc comment and `docs/plans/03-discovery-loop.md`'s Phase 7 for the exact
shape. Sketch:

```ts
import { PlaywrightAdapter } from "./adapter/playwrightAdapter.js";
import { AnthropicModel } from "./discovery/model.js";
import { discover, type DiscoveryGoal } from "./discovery/discover.js";
import { writeDiscoveryEvidence } from "./evidence.js";
import { loadAppProfile } from "./schema/loader.js";

const appProfile = loadAppProfile("../capabilities/fake-credit-union-console.app-profile.json");
const goal: DiscoveryGoal = {
  capabilityId: "...", version: "1.0.0", appId: "fake-credit-union-console",
  description: "...", entryPoint: "/login",
  inputs: { /* name -> { value, sensitivity } — literal values, known only here */ },
  outputs: { /* name -> { sensitivity } */ },
};

const adapter = await PlaywrightAdapter.launch(process.env.TARGET_APP_BASE_URL!);
const result = await discover(goal, appProfile, adapter, new AnthropicModel());
await writeDiscoveryEvidence(goal, result, adapter); // always, regardless of outcome
await adapter.close();
```

`result.status` is one of `done | business_outcome | session_expired |
allowlist_violation | http_error | max_steps | timeout | dead_end |
escalated` — see `discovery/discover.ts`'s `DiscoveryResult` type for what
each carries. Only `done` produces a capability artifact, and it always has
`approvalState: "draft"` — see below.

This costs real Anthropic API tokens per run; the fast unit suite (`FakeModel`,
no network) is what to run on every change instead.

## App profile authoring: `irreversibleControls` and `approvalState`

Two fields in `schema/appProfile.ts` and `schema/capability.ts` exist
specifically because of discovery, and matter to whoever authors or reviews
one:

- **`irreversibleControls`** (`AppProfileSchema`) — an app-wide, human-authored
  list of `{ role, name, exact }` matching controls whose effect is a real,
  hard-to-undo business action (creating a sub-account, submitting a loan,
  closing an account — never a view/navigation control like "Log Out").
  Discovery's policy gate refuses to ever execute a click/type/select whose
  resolved role+name matches an entry here — the model can only escalate
  past it, never retry or route around it. This list starts empty by
  default: an app profile that hasn't been reviewed for irreversible
  controls declares none, rather than silently guessing. Authoring one means
  driving the running app and deciding, as a human, which controls belong
  here — see `evidence/app-profile-verification/irreversible-control-open-sub-account.aria.yaml`
  for a worked example.
- **`approvalState`** (`CapabilityArtifactSchema`) — `"draft"` or
  `"approved"`, defaulting to `"draft"`. Discovery always emits `draft`,
  unconditionally, by construction — nothing in this codebase can produce an
  `"approved"` artifact automatically, and nothing currently *reads or gates
  on* this field either (no unattended-replay restriction exists yet). It
  exists so that gate can be added later without another schema change. A
  human flips a capability to `"approved"` only after reviewing it —
  `capabilities/lookup-member-savings-balance.artifact.json` is the one
  example of that having actually happened.

### What discovery reproduced on its own, and what it didn't

Discovery independently found the same capability the hand-authored
`lookup-member-savings-balance.artifact.json` encodes — login, search, read
the member's name and savings balance — for member `10001`, live against
target-app (see `docs/plans/03-discovery-loop.md`'s Phase 7). Comparing the
two artifacts directly is the honest answer to "what still needs a human":

| | Hand-authored | Discovered | What this means |
|---|---|---|---|
| Locator strategy per step | role+name; row-header structural for both value reads | **Identical** — independently arrived at the same row-header structural pattern, unprompted, with equivalent reasoning ("baking in the observed value wouldn't generalize") | The core perception/locator mechanism works; a human doesn't need to correct *how* discovery finds elements |
| Frame scoping (`read-savings-balance`) | scoped to the `Account Balance` iframe | **Identical** | Same |
| Declared input/output `sensitivity` | none / secret / pii, pii / pii | **Identical** | Discovery correctly propagates the sensitivity the goal declared — it doesn't infer or guess this itself, the caller supplies it |
| `businessOutcomes` | `["member_not_found", "access_denied", "invalid_input"]` — all three the app profile declares, not just the one this recording happened to hit | **`[]`** — empty | **A human has to add these.** One discovery run only ever proves one successful path; it has no way to know which *other* app-profile outcomes this flow could plausibly hit without either re-running against deliberately-bad inputs for each one, or a human who already knows the app profile deciding which apply |
| `approvalState` | `"approved"` | **`"draft"`**, always | The single clearest, structural answer: a discovered artifact is never reviewed by construction, regardless of how clean the run was |
| Locator fallback strategies | `click-log-in` carries a 2-strategy chain: role+name **plus** a scoped, `brittle: true` CSS fallback | Single-strategy only, on every step — the generated rationale says so explicitly | Discovery never invents a selector (the model never writes one, by design); **adding resilience fallbacks is a human, post-review task** |
| Per-step `checkpoint` | `click-search` carries one (`heading_starts_with: "Member:"`) — added specifically because the *final* checkpoint alone couldn't catch a wrong mid-flow landing | **None on any step** | Discovery's `done` tool only lets the model prove the *final* state (design decision 4) — nothing in the current tool surface lets it declare an intermediate one. A real, structural gap, not a missed case |
| `successCheckpoint` | `frame_present` (the `Account Balance` frame exists) | `heading_starts_with: "Account Balance"` (a heading inside that frame) | Not a deficiency either way — a different, arguably stricter choice of proof — but a difference a reviewer should notice and consider reconciling |
| Step ids | semantic (`click-log-in`, `read-savings-balance`) | generic (`click-3`, `read-6`) | Discovery has no way to name a step meaningfully; a reviewer would want to rename these before the artifact is easy to debug from `stepId` alone in evidence/error messages |
| Input/output `description` | present on every field, human-written | **absent** on every field | Discovery never writes documentation prose into an artifact (the same "model never writes free text into structured data" rule that shaped the `escalate` redesign) — a reviewer fills these in |

The pattern across every real difference: discovery gets the *mechanism*
right on its own — perception, locators, redaction, structure — every single
time it was run live. What it structurally cannot do is the *judgment* work:
deciding which business outcomes apply, adding resilience for when the
primary strategy breaks, declaring an artifact fit to run unattended, and
writing down why any of it is true for the next person who reads the file.
That's the review step `approvalState` names, and it's real, not asserted.

## File map

```
schema/            Zod schemas — the artifact format, validated at load time
  capability.ts       capability artifact: inputs, outputs, steps, businessOutcomes, successCheckpoint
  step.ts             click/type/select/read steps; locator chain; per-step timeout and checkpoint
  locator.ts          the locator chain: role+name -> label -> structural -> CSS/XPath (brittle)
  checkpoint.ts        heading_starts_with / frame_present / text_contains
  frame.ts             structured frame reference (by title/name/url), not a raw selector
  appProfile.ts        per-appId: outcome detectors, recovery rules, allowlist, sessionExpiry signal
  tenantOverlay.ts      baseUrl + control-name overrides for a specific tenant
  loader.ts            load + validate a capability/app-profile/tenant-overlay from disk

adapter/            The only place Playwright is imported
  surfaceAdapter.ts    the SurfaceAdapter interface + LocatorResolutionError
  playwrightAdapter.ts  Playwright implementation: snapshot, act, lastNavigationStatus
  snapshotParser.ts    parses Playwright's ariaSnapshot() YAML into a structured Snapshot tree
  matchers.ts          pure functions over a Snapshot: heading/alert/text lookups, shape matching, checkpoint evaluation

executor/            Deterministic replay — no model in the loop
  replay.ts            checkTransition(): the single place detection order lives (hard failure ->
                        allowlist -> session-expiry -> business outcome -> recovery -> per-step
                        checkpoint -> final successCheckpoint); locator-chain translation for
                        tenant overlays; the allowIrreversible gate
  appDetection.ts       createAppDetector(): session-expiry/business-outcome/recovery detection,
                        shared by replay() and discover() — one implementation, not two
  policy.ts             isWithinAllowlist(), isIrreversibleControl() — shared by replay() and discover()
  redact.ts             redactForLog(), scrubSecretValues() — sensitivity- and value-based redaction

discovery/           The LLM-driven observe -> decide -> act loop — no model logic anywhere else
  discover.ts           the loop itself: turn cycle, policy gate, DiscoveryResult, dead-end/timeout/
                        max-steps bounds, composeEscalationReason() (the model never writes free text)
  model.ts              DiscoveryModel interface; AnthropicModel (the only file importing the SDK);
                        the compact-view text renderer and system prompt
  tools.ts               the six-tool surface as Zod schemas + Anthropic tool-use JSON: click, type,
                        select, read, done, escalate — every one either points at a ref or picks from
                        a closed set; none carries a literal value, a selector, a checkpoint, or free text
  compactView.ts         builds the redacted, ref-based view of the page sent to the model each turn
  deriveCheckpoint.ts    turns the model's `done` proof (a ref) into a verified Checkpoint — the model
                        never authors the condition itself, same rule as locators

evidence.ts          writeReplayEvidence() / writeDiscoveryEvidence() — steps.jsonl + a human-readable
                        summary.json under evidence/<replay|discovery>/, resolved relative to the repo
                        root regardless of cwd; screenshot only on a non-success outcome

test/
  schema/, adapter/, executor/, discovery/   fast unit suite (FakeAdapter/FakeModel, no browser, no
                                              network, no .env)
  integration/                                live suite against a real target-app (replay only)
  capabilities/                                validates the real artifacts under capabilities/
  evidence.test.ts                             evidence writing + redaction, including that the default
                                              evidence directory is cwd-independent
```

## Result contract

`replay()` returns a discriminated union — `success | business_outcome |
escalated | failed` — never conflated. See `executor/replay.ts` and CLAUDE.md's
"Result contract" section for the full rationale.

`discover()` returns its own, wider discriminated union — `done | business_outcome
| session_expired | allowlist_violation | http_error | max_steps | timeout |
dead_end | escalated` — reusing the same app-profile detection `replay()`
does (`executor/appDetection.ts`) plus stop conditions specific to an
unattended, model-driven loop. Only `done` carries a capability artifact;
every other status is a distinct, recorded reason discovery didn't produce
one, never a thrown error. See `discovery/discover.ts`'s `DiscoveryResult`
type.

## Capabilities

The hand-authored artifacts this project validates against live under
`/capabilities` at the repo root, along with their own provenance notes —
see `/capabilities/README.md`.
