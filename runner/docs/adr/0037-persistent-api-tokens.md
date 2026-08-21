# ADR-0037: Persistent API tokens, verified in the Worker rather than by the broker

**Status:** Accepted (DEV-2583; amends the scope of 0007)

## Context

The nightly live canary has one step it almost never runs. `e2e-live.yml` guards the
authed share round-trip — the only test that drives the builder, R2 and D1 end to end
against production — behind `secrets.E2E_BROKER_TOKEN`, and that secret is a **per-user
browser session JWT copied by hand out of `sessionStorage.hot_token`**. It expires in
about an hour. The workflow knows this and treats a dead token as a `::notice::` and a
green run, because "the secret rots by design and rot is not a product failure". The
honest reading is that the step is skipped every night and the coverage is theoretical.

There is no mint path to automate. Every credential this runner accepts today is a
broker session token: `authenticate()` does not verify a JWT at all, it forwards the
bearer verbatim to the login broker's `/broker/userinfo` and trusts the address that
comes back (ADR-0007). Nothing in the system can issue a credential, and nothing in the
system can validate one it did not get from the broker.

Two properties of the surrounding code constrain any answer:

- **There is no user table and no organization model.** The organization is the string
  test `email.endsWith("@handsontable.com")`; ownership is `sameOwner(created_by, email)`;
  `profiles` is keyed on the address because "email is the only stable identifier we
  hold" (`0005_profiles.sql`). A token has to live in that world rather than found a
  parallel one.
- **Any team member is already an admin.** `PUT /api/admin/settings` changes the spend
  ceiling and the enforcement switch behind nothing but `authenticate() !== null`, which
  `admin.ts` records as deliberate — spend figures are internal, not secret. That is a
  defensible position for a human who signed in through Google this morning. It is a
  different proposition for a never-expiring string sitting in a **public** repository's
  secrets.

The rejected alternative was to give the CI job a longer-lived broker token, or a broker
service account. It was rejected for the reason ADR-0033 gives for the MCP: that hands a
machine the broker's own authority, and widens the set of things that break when the
broker does. What CI needs is permission to exercise this API, not the ability to present
itself as a person to every system that trusts the broker.

## Decision

**A first-party credential — `hot_pat_<id>_<secret>` — minted from the app, stored as a
hash, verified inside the Worker, and revocable by anyone on the team.**

- **The token is `hot_pat_` + a public id + a secret.** The id is 16 hex characters from
  8 random bytes and the secret is base64url over 32 more, both from
  `crypto.getRandomValues`. The id is deliberately public: it is the D1 primary key, it
  is what the UI shows for the rest of the token's life, and it is what
  `DELETE /api/tokens/:id` names. Nothing anywhere needs to handle the plaintext twice.
- **The prefix is checked before anything touches the network, and the two paths never
  fall through to one another.** This is a security property rather than a latency win: a
  bearer that reached the broker's `/broker/userinfo` because the local lookup missed
  would have shipped our own permanent credential to a third-party host on Render, and
  the failure would look like a slow success.
- **Only a SHA-256 hex digest of the token string is stored.** The plaintext is in the
  mint response and nowhere else — not in the row, not in a log, not in the listing. The
  reflex objection here is bcrypt or argon2, and the answer is that this is a 256-bit
  random secret rather than a password: there is no dictionary to run, no low-entropy
  guess space to grind, and the id makes the lookup a primary-key hit, so there is
  nothing a work factor would be defending. A stretched hash would cost every
  authenticated request and buy nothing.
- **Verification is one indexed read plus the existing constant-time compare.**
  `secretsMatch()` already exists for `MCP_SHARED_SECRET` and is reused unchanged over
  the two digests. Revocation is read in the same row, so it takes effect on the next
  request with no cache to invalidate.
- **A token acts as its creator's address.** The token path returns
  `{ email: row.created_by, via: row.id }`, so `sameOwner()`, `created_by`, `?scope=mine`
  and "My demos" keep working with no new identity shape — and, more to the point, no new
  address that `endsWith("@handsontable.com")` would have to be taught to accept. The
  `via` field is the audit trail and the thing the capability guard reads; nothing that
  only wants `identity.email` changes at all. The cost is stated plainly: a demo created
  by CI is indistinguishable in the listing from one its owner built by hand, and it
  outlives their involvement.
- **A token may do what a person may, minus four things.** No `PUT`/`DELETE` on
  `/api/admin/*`, no `POST /api/chat`, no `POST /api/theme`, and no token management. So
  a leaked token cannot raise the spend ceiling, cannot turn enforcement off, cannot burn
  AI budget, and — the one that matters most — cannot mint itself a successor or revoke
  the tokens that would be used to kill it. `GET /api/admin/*` stays open, because the
  session-leak spec reads `/api/admin/sessions` and reading internal spend figures is
  what `admin.ts` already says it is.
- **The fence is a fixed rule, not a scope field.** Per-token scopes were considered and
  dropped: this repo has never had a permission model, one consumer exists, and a
  configurable fence is a thing to get wrong at mint time. When a second consumer needs
  something different, that is the moment to design scopes.
- **Every token is visible to, and revocable by, the whole team.** `GET /api/tokens`
  lists all of them with creator, timestamps and who revoked what; any signed-in team
  member may revoke any of them. This is the one place where the codebase's standing
  warning — that `?scope=all` is visibility and must never quietly become permission
  (`demos-list.ts`) — is knowingly set aside rather than overlooked. A permanent
  credential nobody but its author can kill is worse than one anybody on the team can:
  the person who minted it will eventually be on holiday, and the token will not expire
  on their behalf.
- **`last_used_at` is coarsened to the hour and written atomically.** A single
  `UPDATE … WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)` bounds the hot
  auth path to one effective write per token per hour, needs no `ctx` threaded through
  the two dozen `authenticate()` call sites, and has no read-then-write race to reason
  about under concurrency.
- **The client accepts one too.** `currentUser()` prefix-branches to the API's own
  `GET /api/profile` instead of the broker's `/broker/userinfo`; `ProfileView` already
  carries `email`, taken straight from the verified identity, which is exactly what the
  caller needs. No new `/api/me` route. This is what keeps the live spec exercising the
  real Share button rather than being rewritten into an API script, and it is the part of
  this decision with the sharpest edge — see below.

## Consequences

The nightly canary can run unattended, and the credential it uses can be killed from the
app by whoever notices first. The token path also costs one D1 read where the broker path
costs a cross-Atlantic fetch to Render, so it is faster and it does not care whether the
broker is up.

**Trade-offs and follow-ups:**

- **A token is a browser session in a string.** Because the client accepts it, anyone
  holding one can paste it into `sessionStorage` in a console and have a signed-in tab
  that never expires. The capability fence, org-wide revocation and the fact that the
  domain-suffix gate already means "team member equals broad authority" bound this; they
  do not remove it. Choosing the other branch — a server-only credential — would have
  removed it at the price of rewriting the one spec that proves the UI path works, and
  the coverage was judged worth more than the theoretical narrowing.
- **The `e2e-live.yml` trace scrubbing is now load-bearing rather than tidy.** That run
  puts the credential in `sessionStorage` and in an `Authorization` header, a Playwright
  trace records both, GitHub does not redact secrets inside artifact zips, and this repo
  is public. Before, a leaked trace exposed a token with an hour to live. Now it exposes
  one with no expiry at all. `--trace off` and the artifact `rm -rf` stay, and the reason
  they exist has gone up in severity.
- **Token failure stops being rot.** A broker token that stopped validating meant a week
  had passed; a persistent token that stops validating means it was revoked, deleted, or
  something is broken. So the workflow's preflight fails the run instead of warning and
  passing — which is the point of the ticket, and also means the first thing this feature
  can do is turn a permanently-green step red.
- **A token session in the SPA will 403 on Chat and the theme generator, and the existing
  classifier calls every 403 an ownership problem.** `apiError.ts` renders "This demo
  belongs to someone else" and marks it reportable, so an unguarded capability denial
  would show the wrong sentence and open a Sentry issue on every click. The session is at
  least not wrongly cleared — only a 401 does that. The answer is that these routes send
  a `detail`, which that branch already appends, and that the UI does not offer AI
  features to a token session in the first place.
- **The admin model is fenced, not fixed.** "Any team member is an admin" is untouched
  here; this decision only declines to extend it to machines. Introducing real roles is
  its own ticket, and this ADR is not a substitute for it.
- **No expiry, no rotation endpoint, no per-token scopes.** Rotation is mint-then-revoke,
  which is two clicks and needs no code. An optional expiry is the obvious first
  extension if these ever leave CI and start living in people's shell profiles.
