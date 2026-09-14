# ADR-0022: The spend ceiling is enforced by the Worker, not by Cloudflare

**Status:** Accepted

## Context

DEV-2030 asks for a fixed monthly cap on the main Handsontable Cloudflare
account, with alerts at 20% / 50% / 80% of it.

Two facts shape the answer:

1. **Cloudflare has no hard spend cap on Workers Paid.** Its Budget alerts (GA
   April 2026) email you when *projected* monthly spend crosses a dollar
   threshold, recomputed daily from day-in-arrears usage. They stop nothing.
2. **`containers.max_instances` already is a hard cap — for containers only.**
   At `Sandbox=5` + `BuilderSandbox=3` on `standard-1`, every slot awake 24/7 for
   a 730-hour month costs roughly $250–$460 including container Durable Object
   duration. That is 25–45% of the $1000 line, and Cloudflare enforces it
   regardless of whether our code is correct.
   <!-- Amended by "The pool is 10/5" below (DEV-2909): the figures are 10/5 and
        ~$469–$863, i.e. 47–86%. The reasoning is unchanged; only the fraction is. -->

What is *not* bounded: container egress (every dev-server asset and HMR frame of
a live preview, on a public unauthenticated `POST /api/session`), Workers Logs
volume, Workers requests, and R2 growth.

## Decision

Three layers, in order of how much we trust them.

1. **Cloudflare Budget alerts** at 20% / 50% / 80% of the ceiling —
   dashboard-only and informational. They are the human early-warning system,
   not the cap. The Worker fires its own alerts on the same thresholds, because
   Cloudflare's are account-wide and cannot tell the runner apart from anything
   else billing to the account.
2. **Configuration that bounds the unbounded**: `observability.head_sampling_rate
   = 0.1` (logs are a spike amplifier), `limits.cpu_ms`, and `max_instances` left
   at 5/3 — that pair *is* the container ceiling and raising it is the single
   change that invalidates the arithmetic above.
   <!-- Amended by "The pool is 10/5" below (DEV-2909): the pair is 10/5, and the
        arithmetic above was redone with it. "Raising it invalidates the table"
        stands — it is the standing obligation, not a prohibition. -->
3. **A ceiling the Worker enforces itself.** A `cost_ledger` table in D1 meters
   container awake-seconds, proxied egress and request counts; a nightly cron
   replaces those estimates with Cloudflare's own analytics. Crossing a fraction
   of `BUDGET_MONTHLY_USD` degrades the product in stages: notice at 60%,
   sign-in required at 80%, no new sessions or builds at 95%, running sessions
   torn down at 100%.

The design constraint on that last layer is **graceful degradation**: static
shares (`/d/:id`, `/embed/:id`) are R2 reads, cost effectively nothing, and keep
working at every tier. Only the container paths are switched off.

The thresholds are **absolute dollars stored in D1 and editable from the admin
panel**, with the `BUDGET_*` vars as defaults. A ceiling you can only change by
deploying is a ceiling nobody adjusts during the incident that needs it.

## Consequences

- The ceiling is only as good as our meter, so it ships observe-only
  (`BUDGET_ENFORCE=0`) and is compared against the Billable Usage dashboard for
  a week before it is allowed to refuse anything.
- Anything that can turn the guardrail off from a web page needs an audit
  trail, so overrides record who saved them and when, and every change is
  logged.
- Estimates round against us on purpose; the nightly reconciliation is what
  keeps that from compounding, and a `billing` row always beats an `estimate`
  row for the same day.
- The `anon_blocked` tier assumes live editing may require a login. If anonymous
  live editing becomes a hard product requirement, that tier collapses into
  `new_blocked` and the ceiling gets blunter.
- Budget alerts are account-wide, so anything else billing to the same account
  counts toward the same threshold. Either offset the thresholds by the
  account's existing baseline, or move the runner to its own account — the
  latter is a bigger call than DEV-2030.

## Amendment — the pool is 10/5 (DEV-2909)

`Sandbox` is 10 and `BuilderSandbox` is 5. `docs/cost-guardrails.md` carries the
redone arithmetic; the decision this ADR records does not change.

The 5/3 pair was set before the runner carried traffic, and it turned out to be
rationing the cheapest thing in the ledger. Once the runner reached 500–900 live
sessions a day the pool started refusing visitors (Sentry DEMOS-33, the
`at_capacity` 503), while metered container spend sat at **~$5/month** — about
1% of the worst-case row that justified the cap. The worst case assumes every
slot awake 24/7; real sessions sleep after 5m.

Two things this amendment makes explicit, because the original text conflated
them:

- **`max_instances` is doing two jobs.** It is the container spend cap *and* the
  only limit on how many visitors can hold a live preview at once — there is no
  queue in front of the pool. Sizing it for spend alone prices out users.
- **Containers can now reach the ceiling on paper.** At 10/5 the pathological
  end of the table is ~86% of $1000, where 5/3 was 46%. Layer 3 — the tiers this
  ADR exists to justify — is what stops a sustained saturation event now, rather
  than Cloudflare's cap making one arithmetically impossible. That is a real
  weakening of layer 2, accepted deliberately: a cap that never binds financially
  but refuses paying attention is not a guardrail, it is an outage.

If the pool is raised again, the honest options are to re-price (a smaller
instance type for live previews) or to state that the tiers, not
`max_instances`, are the container cap.
