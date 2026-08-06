# ADR-0022: The spend ceiling is enforced by the Worker, not by Cloudflare

**Status:** Accepted

## Context

DEV-2030 asks for a $1000/month cap with alerts at $200 / $500 / $800 on the main
Handsontable Cloudflare account (`15111272c53ed0aaf84a908f0c9c7f8b`).

Two facts shape the answer:

1. **Cloudflare has no hard spend cap on Workers Paid.** Its Budget alerts (GA
   April 2026) email you when *projected* monthly spend crosses a dollar
   threshold, recomputed daily from day-in-arrears usage. They stop nothing.
2. **`containers.max_instances` already is a hard cap — for containers only.**
   At `Sandbox=5` + `BuilderSandbox=3` on `standard-1`, every slot awake 24/7 for
   a 730-hour month costs roughly $250–$460 including container Durable Object
   duration. That is 25–45% of the $1000 line, and Cloudflare enforces it
   regardless of whether our code is correct.

What is *not* bounded: container egress (every dev-server asset and HMR frame of
a live preview, on a public unauthenticated `POST /api/session`), Workers Logs
volume, Workers requests, and R2 growth.

## Decision

Three layers, in order of how much we trust them.

1. **Cloudflare Budget alerts** at $200/$500/$800 — dashboard-only, manual, and
   informational. They are the human early-warning system, not the cap.
2. **Configuration that bounds the unbounded**: `observability.head_sampling_rate
   = 0.1` (logs are a spike amplifier), `limits.cpu_ms`, and `max_instances` left
   at 5/3 — that pair *is* the container ceiling and raising it is the single
   change that invalidates the arithmetic above.
3. **A ceiling the Worker enforces itself.** A `cost_ledger` table in D1 meters
   container awake-seconds, proxied egress and request counts; a nightly cron
   replaces those estimates with Cloudflare's own analytics. Crossing a fraction
   of `BUDGET_MONTHLY_USD` degrades the product in stages: notice at 60%,
   sign-in required at 80%, no new sessions or builds at 95%, running sessions
   torn down at 100%.

The design constraint on that last layer is **graceful degradation**: static
shares (`/d/:id`, `/embed/:id`) are R2 reads, cost effectively nothing, and keep
working at every tier. Only the container paths are switched off.

## Consequences

- The ceiling is only as good as our meter, so it ships observe-only
  (`BUDGET_ENFORCE=0`) and is compared against the Billable Usage dashboard for
  a week before it is allowed to refuse anything.
- Estimates round against us on purpose; the nightly reconciliation is what
  keeps that from compounding, and a `billing` row always beats an `estimate`
  row for the same day.
- The `anon_blocked` tier assumes live editing may require a login. If anonymous
  live editing becomes a hard product requirement, that tier collapses into
  `new_blocked` and the ceiling gets blunter.
- Budget alerts are account-wide, so anything else billing to account
  `15111272…` counts toward the same $200. Either offset the thresholds by the
  account's existing baseline, or move the runner to its own account — the
  latter is a bigger call than DEV-2030.
