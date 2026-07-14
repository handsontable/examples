# ADR-0020: Worker routes live in the deploy command, not wrangler.jsonc

**Status:** Accepted

## Context
When `wrangler.jsonc` declares `routes`, `wrangler dev` simulates the first
route's host on every request: `request.url` and `Host` become
`demos.handsontable.com` no matter what hostname the request actually targeted;
only the pathname passes through. This destroys the
`<port>-<sandboxId>-<token>.*` preview hostnames that the Sandbox SDK's
`proxyToSandbox()` routes by, so Tier-2 local preview can never work while
routes are in the config — no `PREVIEW_HOST` value helps. Wrangler has no
config key or CLI flag to disable the simulation (`inferOriginFromRoutes` is
only settable via the programmatic `startWorker` API); `--host` merely
simulates a different fixed host. This corrects ADR-0011's claim that local
`wrangler dev` "works via `*.localhost`" — that was true only before the
routes block was added. An alternative (path-based `/__preview/<encoded>/`
proxying with Referer-based asset routing) was rejected: it would exercise a
different code path locally than in production and likely break HMR, since
WebSocket upgrades don't reliably carry `Referer`.

## Decision
Declare no `routes` in `wrangler.jsonc`. Attach the production routes at
deploy time via `wrangler deploy --routes …` in the api worker's `deploy`
script (package.json), keeping the patterns versioned. Local dev sets
`PREVIEW_HOST="localhost:8787"` in `.dev.vars` (a real value — wrangler
silently ignores empty-string overrides).

## Consequences
- `wrangler dev` passes the real `Host` through, so `*.localhost:8787` preview
  URLs flow through the same `proxyToSandbox()` path as production — verified:
  HTML, assets, HMR WebSocket, live file edits, concurrent sessions.
- `--routes` cannot carry `zone_name`; wrangler infers the zone on real
  deploys (errors loudly if it can't). Unverified as of this ADR — watch the
  first deploy; fallback is dashboard-managed routes.
- Routes must never move back into `wrangler.jsonc`; doing so silently breaks
  local Tier-2 preview for every container-engine framework.
