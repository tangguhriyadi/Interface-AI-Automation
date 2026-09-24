# Plan: `/target-app` — Fake Credit-Union Servicing Console

**Source**: conversational request (no PRD)
**Selected scope**: `/target-app` only — the black-box UI the automation agent (`/src`, planned separately) will drive
**Complexity**: Medium

## Summary

Build a standalone Express + TypeScript, server-rendered web app under `/target-app` that stands in for a real bank's servicing console — a black box the future `/src` automation agent will drive purely through the UI (per CLAUDE.md's hard boundary: no shared code/types between `/src` and `/target-app`).

- No `data-testid` anywhere; layout uses nested `<table>` elements, but every control is native HTML (`<button>`, `<input>`, `<label for=>`, `<table>`) so the accessibility tree yields real roles + accessible names.
- Pages: login (env-var dummy creds) → member search → member detail (balance panel embedded via `<iframe>`) → open-sub-account flow (form → review → confirm).
- Fixture data lives in JSON.
- Deterministic failure injection keyed by member ID: `10001`–`1000x` normal (3–4 fixture members), `99999` not found, `10002` access denied, `10003` dismissable maintenance interstitial, `10004` 6s slow load, `10005` HTTP 500, non-numeric input → validation error, plus an env-configurable request-count threshold that forces session expiry mid-flow.
- `TENANT` env flag overlays visible control labels (Member ID→Account Number, Search→Find) to simulate a second tenant on the same vendor product — labels only, not real multi-tenant routing (that's explicitly out of scope per CLAUDE.md).
- `/target-app` and the future `/src` are two independent npm projects, each with its own `package.json`, run in separate terminals — no workspace/monorepo tooling.

## Pattern Grounding

Repo is currently empty except `.claude/` config and `CLAUDE.md` — **no existing code to mirror**. This is a from-scratch scaffold. Follows CLAUDE.md's stated stack (TS/Node/ESM/strict) and keeps dependencies minimal: Express, `express-session`, and plain TypeScript functions returning HTML strings instead of a templating engine — avoids an extra dependency and gives full control over accessible markup (labels, nested tables) with a small manual `escapeHtml` helper.

## Design decisions worth flagging before implementation

1. **Business outcomes vs. technical failures**: `not_found` (99999), `access_denied` (10002), and non-numeric input all render normal `200` pages with clear messaging — mirroring how a real banking UI behaves (it doesn't throw HTTP 403 for a restricted member). Only `10005` returns a real `500`. This matches the `business_outcome` vs `failed` split in CLAUDE.md's result contract, one layer up in `/src`.
2. **Interstitial (10003)** is fully server-rendered, no client JS: first GET to that member's detail page renders an interstitial-only page with a real `<button>` that POSTs to a dismiss route; session marks it dismissed; subsequent GETs show real content. Deterministic, replayable, no timing games.
3. **Session expiry** is `EXPIRE_SESSION_AFTER_REQUESTS=<n>` — the session is valid for exactly `n` authenticated requests after login, then the next request is treated as expired and redirected to `/login`. A boolean "always expired" flag would make login itself impossible and couldn't demonstrate a timeout *mid-flow* (e.g., partway through the sub-account form) the way a request-count threshold can. Unset/`0` means "never expire." Deterministic and replayable — no wall-clock racing.
4. **Sub-account flow is stateless across steps**: review page re-passes all fields as hidden inputs; Back is a real link back to step 1 with values pre-filled via query params (not a dead button) — no half-finished flow.
5. **6-second slow load** is env-overridable (`SLOW_LOAD_MS`, defaults 6000) so a future test suite isn't forced to eat 6s per run, while the spec'd default stays 6s for real discovery/replay demos.
6. **Balance panel structure**: rendered as a `<table>` with one row per account, `<th scope="row">` holding the account label ("Savings", "Checking") and a `<td>` holding the formatted balance — so the value is reachable by header-to-cell association (accessible-tree "row header"), not by column position. All money values render fixed as `$1,234.56` (two decimals, comma thousands separator) everywhere in the app, not just the balance panel.
7. **Fixtures**: 3–4 distinct normal members with different names and balances, so a parameterised replay (`{ fromInput: "memberId" }`) is actually proven against more than one hardcoded case, not just `10001`. IDs `10002`, `10003`, `10004`, `10005` are reserved for failure injection, so the normal-member set is `10001`, `10006`, `10007`, `10008`.

## Files to Create

| File | Why |
|---|---|
| `target-app/package.json`, `tsconfig.json` | ESM, strict TS, Express |
| `target-app/.env.example` | documents every env var, no secrets committed |
| `target-app/src/server.ts` | Express bootstrap, router mounting |
| `target-app/src/config.ts` | parses creds, TENANT, failure/session env flags |
| `target-app/src/tenantLabels.ts` | label overlay keyed by TENANT |
| `target-app/src/session.ts` | express-session setup, `requireAuth`, forced-expiry + interstitial-dismissed state |
| `target-app/src/fixtures/members.json` | member fixture data: 4 plain normal members (`10001`, `10006`, `10007`, `10008`, distinct names/balances, used for the parameterised-replay proof) plus content for `10003`/`10004` so the interstitial-dismiss and slow-load flows have a real member to reveal once their hurdle clears |
| `target-app/src/data/memberStore.ts` | loads fixtures, in-memory sub-account writes |
| `target-app/src/failureInjection.ts` | memberId → behavior mapping |
| `target-app/src/subAccountTypes.ts` | fixed account-type list shared by the sub-account form and its server-side validation |
| `target-app/src/routes/memberLookup.ts` | single source of truth for the deterministic invalid/denied/error/not-found outcomes, so `member.ts` and `subAccount.ts` can't drift on the same member ID |
| `target-app/src/money.ts` | fixed `$1,234.56`-style formatter used everywhere money is rendered |
| `target-app/src/views/*.ts` | `layout`, `loginPage`, `searchPage`, `memberDetailPage`, `balancePanel` (row-header table), `subAccountNewPage`, `subAccountReviewPage`, `subAccountConfirmPage`, `messagePage` (business outcomes + hard failures, distinct title per case), `interstitial` |
| `target-app/src/routes/{auth,search,member,subAccount}.ts` | route handlers |
| `target-app/README.md` | env vars (incl. `EXPIRE_SESSION_AFTER_REQUESTS`), member-ID behavior table, two-terminal run instructions (`/target-app` and future `/src` as independent npm projects) |
| `target-app/test/*.test.ts` (mandatory, Phase 6) | one supertest smoke test per injected behavior |

## Tasks

### Phase 0 — Scaffold
- **Action**: package.json/tsconfig, dir skeleton, health route
- **Validate**: `npm run dev` boots

### Phase 1 — Config, fixtures, failure map
- **Action**: env parsing (incl. `EXPIRE_SESSION_AFTER_REQUESTS`), tenant label overlay, `members.json` (4 normal members: `10001`, `10006`, `10007`, `10008`, distinct names/balances), `memberStore`, `failureInjection` (returns `normal | not_found | access_denied | maintenance_interstitial | slow_load | server_error | invalid_input`), `money.ts` formatter

### Phase 2 — Shared views
- **Action**: `layout.ts` (HTML shell + nested-table helper + `escapeHtml`), `messagePage.ts` (title required — renders both business-outcome and hard-failure pages with a distinct heading each), `interstitial.ts`

### Phase 3 — Auth
- **Action**: `session.ts` (store, `requireAuth`, per-session request counter compared against `EXPIRE_SESSION_AFTER_REQUESTS`), `loginPage.ts`, `routes/auth.ts` (GET/POST `/login`, POST `/logout`), creds checked against `TARGET_APP_USERNAME`/`TARGET_APP_PASSWORD`

### Phase 4 — Search & member detail
- **Action**: `searchPage.ts` (tenant-labeled), `memberDetailPage.ts`, `balancePanel.ts` (iframe target with `title`; `<table>` with `<th scope="row">` per account — "Savings", "Checking" — and a `<td>` value cell in `$1,234.56` format), `routes/search.ts`, `routes/member.ts` wiring every failure-injection branch including interstitial dismiss route and slow-load delay

### Phase 5 — Sub-account flow
- **Action**: `subAccountNewPage.ts` (prefillable via query params), `subAccountReviewPage.ts` (hidden-field passthrough, one-time session-issued token, "Confirm and Open Account" button), `subAccountConfirmPage.ts` (clear success checkpoint markup, e.g. `<h1>Sub-Account Created</h1>` + `<p>Sub-Account ID: …</p>`), `routes/subAccount.ts` (every step resolves the member ID via `memberLookup.ts`; deposit enforced between $25.00 and $1,000,000.00; confirm consumes the one-time token and 302-redirects — POST-redirect-GET — to a `GET .../sub-account/:subAccountId/created` page that renders the checkpoint from the persisted record, so neither a double-submit nor a refresh can create a duplicate)

### Phase 6 — Smoke tests (mandatory, kept thin)
- **Action**: vitest + supertest, one smoke test per injected behavior — `normal` (one fixture member), `not_found`, `access_denied`, `maintenance_interstitial` (dismiss flow), `slow_load` (with `SLOW_LOAD_MS` overridden low via test env, not the real 6000ms default), `server_error`, `invalid_input`, plus one test each for `EXPIRE_SESSION_AFTER_REQUESTS` mid-flow expiry, TENANT label overlay, and the sub-account happy path. No coverage-percentage chasing beyond that list.
- **Pinned contract**: the mid-flow expiry test must assert exactly which request triggers the redirect — including that the balance-panel iframe's own `GET /members/:id/balance` request counts as a separate tick against the same limit as the parent page, so a limit can expire strictly between the parent page loading and its iframe loading. This is documented behavior (see `target-app/README.md`), not a bug.
- **Coverage added after the Phase 4/5 fixes**: duplicate-submission rejection (same token resubmitted, exactly one sub-account persists), the confirm 302 → `/created` GET checkpoint, deposit-limit boundaries (`0`/`24.99`/`1000000.01` rejected, `25.00` accepted), cross-route consistency (`10002` renders Access Denied on the sub-account route, not Member Not Found), and empty search input re-rendering with `role="alert"` instead of a 404. 17 tests / 5 files total.
- **Why**: since `/src` can never read `/target-app` internals, this suite is the only proof the failure-injection contract behaves as documented — future discovery/replay work depends on it being right

### Phase 7 — Docs & wiring (done)
- **Action**: mounted `configureSession` + all four routers in `server.ts` behind `requireAuth`; wrote `target-app/README.md` with the full member-ID table (incl. `10003`/`10004` as fixture-backed recovery-then-success, and the cross-route guarantee for `10002`/`10005`), the env var table, two-terminal run instructions, npm scripts reference, the extended session-expiry semantics (adds the 4-tick sub-account sequence and the confirm/created-split note), the duplicate-submission token, and the deposit limits

## Validation

```bash
cd target-app
npm run build        # tsc --noEmit, strict mode clean
npm run dev           # boots on $PORT
npm test              # Phase 6 smoke suite, mandatory
```

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| iframe complicates later a11y-tree traversal in `/src` | Medium | explicit `title` attr, same-origin, documented in README |
| 6s slow load makes any test suite slow | Medium | `SLOW_LOAD_MS` env override, default stays 6000, tests set it low |
| Session-scoped interstitial dismissal doesn't match "recoveries checked at every transition" semantics that `/src` will implement | Low | document exact behavior in README so `/src`'s recovery logic is built against known ground truth |
| `EXPIRE_SESSION_AFTER_REQUESTS` counting logic miscounts (e.g. off-by-one on the login request itself) and expires too early/late | Low | Phase 6 has a dedicated mid-flow expiry test asserting the exact request the redirect kicks in on |
| Scope creep (extra pages/fields not asked for) | Low | stick strictly to the 4 pages + fields listed above |

## Acceptance
- [x] All failure-injection member-ID behaviors (`10001` normal, `99999`, `10002`, `10003`, `10004`, `10005`) + non-numeric + mid-flow session-expiry (including the pinned iframe-tick sequence) + TENANT overlay + sub-account happy path covered by the Phase 6 smoke suite (`npm test`, 4 files / 12 tests, all passing)
- [x] Balance panel values are reachable by row-header association (`th scope="row"` → `td`), not position; all money renders as `$1,234.56`
- [x] No `data-testid` anywhere; every control has a real accessible name
- [x] `/src` boundary respected — nothing in target-app assumes or exposes internals to a future consumer beyond HTTP/HTML; `/target-app` and `/src` remain separate npm projects
- [x] `target-app/README.md` documents env vars (incl. `EXPIRE_SESSION_AFTER_REQUESTS`), the member-ID table, the two-terminal run instructions, the sub-account tick sequence, the duplicate-submission token, and the deposit limits
