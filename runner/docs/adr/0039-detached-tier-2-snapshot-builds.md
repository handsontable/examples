# ADR-0039: Detached tier-2 snapshot builds on the MCP service path

**Status:** Accepted (amends ADR-0033)

## Context

`POST /api/mcp/demos` (ADR-0033) runs `createDemo()` — validate, boot a builder
container, build, upload to R2, insert the row — synchronously inside the request,
and answers only when the artifact is live. That contract is honest and simple, and
it is fine for everything the in-browser editor does, because a browser waits.

The MCP callers do not. The clients driving hot-mcp abort a tool call at roughly
60 seconds, and aborting the HTTP request cancels the whole chain — hot-mcp's
Worker, its fetch to this runner, and the builder execs in flight. A cold tier-2
build (`next`, `ng`, `astro`, `nuxt`, `remix`: real installs, real framework
builds) reliably takes longer than that. The observed result, three times in a
row against production: timeout at the client, build cancelled mid-flight,
**no demo, no error recorded anywhere, three container boots billed for nothing**.
Because the row was only ever inserted after a successful build, the failure was
also invisible — nothing in D1, nothing on /admin, only the caller's timeout.

Two non-solutions, considered and rejected:

- **Raise the client timeout.** Not ours to raise (every MCP client has its own),
  and a 60-second tool call is already a bad tool call.
- **`ctx.waitUntil()`.** Capped at 30 seconds after the response is sent —
  documented, and an order of magnitude short of a cold `next build`.

## Decision

**A tier-2 create or rebuild with no cached identical build detaches: the route
records the demo as `building`, parks the payload in R2, hands the build to a
`BuildJob` Durable Object alarm, and answers 202 immediately. Everything else —
tier 1, and any build already in `build_cache` — keeps the synchronous 201/200
answer it always had.**

- **The demos row carries the build state** (`0007_build_status.sql`):
  `build_status` (`ready` | `building` | `failed`, default `ready` — every
  pre-existing row earned it by finishing a build) and `build_error`, a one-line
  cause, never a log (the DEMOS-1Y rule). A row stuck in `building` longer than
  any build can legitimately run (`STALE_BUILD_MS`, comfortably above the alarm's
  15-minute wall cap plus its bounded retries) *reads* as failed — the backstop
  for a schedule that never ran or a failure mark that never landed.
- **Why a Durable Object alarm:** it is the platform's primitive for "finish this
  work even though the caller is gone" — 15 minutes of wall time, at-least-once
  execution, retried by the platform only when the handler throws. The alarm
  therefore never throws: a deterministic failure is written to the row, because
  the platform's retry budget must not be spent re-running a container build that
  already failed on its own merits. The one transient it does wait out is an
  at-capacity builder pool, bounded (`MAX_CAPACITY_ATTEMPTS`) because those
  retries cost nothing — no container ever booted. One object per demo id, so a
  demo's builds serialize and the object holds state only mid-build.
- **The alarm's finalizer is `updateDemo()`**, not a re-implementation: it already
  owns build-or-copy, the R2 upload, `build_cache`, the source snapshot, and now
  flipping `build_status` back to `ready`. The job record in DO storage is tiny —
  the files wait in R2, under the demo's own prefix.
- **A create parks `__source.json` up front** (it is byte-identical to what a
  finished build stores, and it makes /share readable while the build runs); **a
  rebuild parks `__job.json` instead**, so the stored source keeps matching the
  artifact still being served until the rebuild actually succeeds. Rebuild
  metadata (title/description) lands with the 202, not with the build — a failed
  build must not eat a rename.
- **The 202 body is the 201 body plus `status` and `statusUrl`** — deliberately a
  superset, so a hot-mcp deployed before this change parses it unchanged (it
  checks `resp.ok` and reads the same keys). `GET /api/mcp/demos/:id/status`
  (service auth, same secret) is the polling half of the contract.
- **/d and /embed answer the gap honestly, but only when there is nothing to
  serve**: a first build in flight is a self-refreshing 503 with `Retry-After`, a
  failed first build a 500 — while a demo mid-*rebuild* (or whose rebuild failed)
  keeps serving its previous artifact, exactly as the synchronous Save always
  has. `PATCH` refuses to race a running build (409 `already_building`) rather
  than queue behind it, because the per-demo job slot is last-write-wins.

## Consequences

- The MCP can finally create tier-2 demos: the tool call answers in milliseconds
  with real links, and the page behind them assembles itself when the build lands.
- A new failure surface — the row can now say `failed` — which is an improvement
  over the prior art (nothing anywhere). Failures also keep their Sentry shape:
  the alarm reports `BuildFailure` with the same tags and fingerprint as the
  synchronous path, so both land in the same groups.
- **Deploy order matters once:** `0007_build_status.sql` must be applied to the
  production D1 before this code deploys — `updateDemo()` now names the new
  columns on every save path, browser included.
- hot-mcp needs nothing, but *may* later poll `statusUrl` and report the built
  page the way ADR-0062 (its side) wants — a follow-up there, not here.
