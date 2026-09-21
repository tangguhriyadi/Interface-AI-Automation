# target-app

Fake credit-union servicing console used as the black-box UI target for the
interface.ai take-home automation agent. This file is being filled in
incrementally as the app is built; env vars, the member-ID behavior table,
and full run instructions land in a later pass.

## Session expiry semantics

Controlled by `EXPIRE_SESSION_AFTER_REQUESTS=<n>` (see `.env.example`):

- The session survives exactly `n` requests to any `requireAuth`-protected
  route after login. The request immediately past that limit is redirected
  to `/login?expired=1` instead of being served.
- `0` (the default) means the session never expires.
- **Every protected HTTP request counts as one tick — including requests the
  browser makes on its own to embedded content.** A full member lookup
  performed through the UI is actually **three** separate protected requests,
  each consuming its own tick:
  1. `POST /search` (submitting the search form)
  2. `GET /members/:id` (the redirect target, i.e. the member detail page)
  3. `GET /members/:id/balance` (the balance panel's iframe `src`, fired by
     the browser as soon as the detail page's HTML is parsed)
- Because the parent page and the iframe are separate requests, the limit can
  expire strictly *between* them: the parent page renders normally, but the
  iframe's own request lands past the limit and gets redirected to `/login`,
  so the login page ends up rendered **inside the iframe** while the
  surrounding member detail page looks unaffected. This is intentional — it
  mirrors how a real embedded widget's session can expire independently of
  its host page — and is not treated as a bug. A future `/src` agent must be
  able to detect and handle this rather than assume the whole page failed
  together.
