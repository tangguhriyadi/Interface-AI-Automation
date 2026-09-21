# target-app

Fake credit-union servicing console used as the black-box UI target for the
interface.ai take-home automation agent (`/src`, built separately). Server-
rendered, no client JS, native HTML controls throughout (`button`, `input`,
`label for=`, `table`) so the accessibility tree yields real roles and
accessible names — see the top-level project `CLAUDE.md` for the full design
rationale and the hard boundary between this app and `/src`.

## Running it

`/target-app` and `/src` are two independent npm projects — no workspace, no
shared `package.json`, no shared code. Run them in separate terminals.

**Terminal 1 — this app:**
```bash
cd target-app
cp .env.example .env   # fill in TARGET_APP_USERNAME, TARGET_APP_PASSWORD, SESSION_SECRET
npm install
npm run dev             # http://localhost:4000 by default
```

**Terminal 2 — the automation agent** (once built), pointed at this app's
base URL, driving it purely through the UI.

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | starts the server with `--env-file=.env`, restarts on change |
| `npm run build` | `tsc --noEmit` — type-checks only, nothing is emitted |
| `npm start` | starts the server once, with `--env-file=.env` |
| `npm test` | runs the Vitest smoke suite — never reads `.env`; every test sets its own env inline so results don't depend on your machine |

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TARGET_APP_USERNAME` | yes | — | dummy login username |
| `TARGET_APP_PASSWORD` | yes | — | dummy login password |
| `SESSION_SECRET` | yes | — | signs the session cookie |
| `PORT` | no | `4000` | server port |
| `TENANT` | no | `default` | `default` or `beta`; overlays visible control labels (Member ID → Account Number, Search → Find) |
| `EXPIRE_SESSION_AFTER_REQUESTS` | no | `0` (never expire) | see [Session expiry semantics](#session-expiry-semantics) |
| `SLOW_LOAD_MS` | no | `6000` | delay applied to member `10004`; override low in tests |

`loadConfig()` throws, naming the variable, if a required one is missing or
empty, or if a numeric one is `NaN` or negative. `.env.example` lists all of
them with placeholder values only — never commit real values.

## Member-ID behavior table

Every route that resolves a member ID — the detail page, its balance
iframe, and every sub-account route (new/review/confirm/created) — reaches
the **identical** outcome for the same ID. This is enforced by one shared
check (`src/routes/memberLookup.ts`), not duplicated per route, so `10002`
and `10005` in particular can never render member data anywhere, on any
route.

| Member ID | Outcome | Notes |
|---|---|---|
| `10001` | Normal | fixture: Elena Cho |
| `10006` | Normal | fixture: Marcus Webb |
| `10007` | Normal | fixture: Priya Natarajan |
| `10008` | Normal | fixture: Jonah Reyes |
| `10002` | Access Denied | no fixture — never renders member data, on **any** route (detail page, balance iframe, sub-account new/review/confirm) |
| `10003` | Maintenance interstitial, **then Normal** | fixture: Dana Okafor. The first `GET /members/10003` in a session shows a dismissable interstitial; after `POST .../dismiss-interstitial`, that same ID renders its real member content. A recoverable condition that ends in success, not just a hurdle. |
| `10004` | Slow load, **then Normal** | fixture: Sam Delacroix. Delays by `SLOW_LOAD_MS`, then renders its real member content. Also ends in success. |
| `10005` | Server Error (HTTP 500) | no fixture — never renders member data, on **any** route, same guarantee as `10002` |
| `99999` | Member Not Found | reserved not-found sentinel |
| any other numeric ID | Member Not Found | fallback for IDs that aren't reserved and aren't in fixtures |
| non-numeric, or empty/whitespace | Invalid Input | member-ID routes reject any non-digit string; the search form additionally rejects empty submissions itself (see below) before ever reaching a `/members/:id` route |

## Session expiry semantics

Controlled by `EXPIRE_SESSION_AFTER_REQUESTS=<n>` (see `.env.example`):

- The session survives exactly `n` requests to any `requireAuth`-protected
  route after login. The request immediately past that limit is redirected
  to `/login?expired=1` instead of being served.
- `0` (the default) means the session never expires.
- **Every protected HTTP request counts as one tick — including requests the
  browser makes on its own to embedded content, and including every step of
  a multi-step flow.**

**A full member lookup** performed through the UI is **three** separate
protected requests, each consuming its own tick:
1. `POST /search` (submitting the search form)
2. `GET /members/:id` (the redirect target, i.e. the member detail page)
3. `GET /members/:id/balance` (the balance panel's iframe `src`, fired by
   the browser as soon as the detail page's HTML is parsed)

Because the parent page and the iframe are separate requests, the limit can
expire strictly *between* them: the parent page renders normally, but the
iframe's own request lands past the limit and gets redirected to `/login`,
so the login page ends up rendered **inside the iframe** while the
surrounding member detail page looks unaffected. This is intentional — it
mirrors how a real embedded widget's session can expire independently of
its host page — and is not treated as a bug.

**Opening a sub-account** through the UI, starting from an already-loaded
member detail page, is **four more** separate protected requests:
1. `GET /members/:id/sub-account/new`
2. `POST /members/:id/sub-account/review`
3. `POST /members/:id/sub-account/confirm`
4. `GET /members/:id/sub-account/:subAccountId/created` (the
   post-redirect-get target confirm 302s to)

The confirm **POST** and the **created GET** are separate ticks, and the
limit can expire strictly between them too. Critically: the sub-account is
created inside the confirm handler *before* the redirect is issued, so if
the limit trips exactly at that boundary, **the sub-account still gets
created even though the user never sees the "Sub-Account Created" page** —
they see a login redirect instead. A future `/src` agent must not treat "no
success page shown" as proof nothing happened; for an irreversible step like
this one, that ambiguity is exactly the kind of case that should escalate
rather than assume failure and retry.

## Sub-account flow

### One-time confirm token (duplicate-submission protection)

The review step (`POST .../sub-account/review`) issues a random one-time
token, stored server-side in the session and embedded as a hidden field in
the review page's Confirm form. `POST .../sub-account/confirm` consumes it
atomically: a missing, already-consumed, or mismatched token renders a
"Duplicate Submission" page and creates nothing. A double-click, a
browser back-then-resubmit, or a replayed confirm request can therefore
never create two sub-accounts from one review.

### Deposit limits

The initial deposit must be between **$25.00 and $1,000,000.00**, inclusive
of both bounds — zero and anything below $25.00 is rejected, anything above
$1,000,000.00 is rejected. The rejection message names both bounds. The
limit is enforced independently at both the review step and the confirm
step, since confirm never trusts the hidden fields carried forward from
review.

### Success checkpoint (post-redirect-get)

A successful confirm never renders the confirmation page directly — it
redirects (302) to `GET /members/:id/sub-account/:subAccountId/created`,
which reads the just-created record and renders the checkpoint
(`<h1>Sub-Account Created</h1>` plus `Sub-Account ID: ...`). Because that
page is a GET, refreshing it is idempotent and can never create a second
sub-account.
