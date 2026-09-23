# automation

The core of the computer-use automation system: typed capability artifacts, a
Playwright-backed surface adapter, and a deterministic replay executor. This
project has no knowledge of `/target-app` beyond its rendered UI — see "The
hard boundary" in the repo root `CLAUDE.md`.

Not yet included (later plans): the LLM discovery loop, the escalation/
handoff mechanism, and the `discover`/`replay` CLI. Right now this project is
a library, exercised directly from its test suite.

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
  redact.ts             redactForLog(), applied by sensitivity at the point of capture

test/
  schema/, adapter/, executor/   fast unit suite (FakeAdapter, no browser, no .env)
  integration/                    live suite against a real target-app
  capabilities/                    validates the real artifacts under capabilities/
```

## Result contract

`replay()` returns a discriminated union — `success | business_outcome |
escalated | failed` — never conflated. See `executor/replay.ts` and CLAUDE.md's
"Result contract" section for the full rationale.

## Capabilities

The hand-authored artifacts this project validates against live under
`/capabilities` at the repo root, along with their own provenance notes —
see `/capabilities/README.md`.
