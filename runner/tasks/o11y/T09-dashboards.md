# T09 — Dashboards as code

| | |
|---|---|
| Status | todo |
| Size | L |
| Depends on | T00, T01 (provisioning path and local stack); real data from T02, T05–T08 when they land |
| Blocks | T11 |
| ADR | 0041 rev. 3 §F.2 (dashboard list), §F.3 (no alert rules in Grafana); contract §3, §4 |
| Owns | `containers/o11y/grafana/dashboards/**`, `scripts/o11y-seed.mjs`, `pipeline/o11y-dashboards.test.mjs` |

## Goal

Every dashboard the ADR lists exists as provisioned JSON, renders against the local
stack, and uses only queries that are correct for Analytics Engine's sampling and
dialect.

## Read first

- ADR-0041 §F.2 and §F.3 (Cost is ADR-0043's, Examples & features is T12's).
- Contract §3 (labels), §4 (columns and the reading rule), §5 (metrics and outcomes).
- The Faro starter dashboards in `grafana/faro-web-sdk/dashboards/` as a reference for the
  Loki side, not as a copy.

## Scope

In:

- `scripts/o11y-seed.mjs`: a synthetic generator writing realistic contract-shaped rows to
  local ClickHouse and OTLP log records straight to Loki (both tenants), so dashboards can
  be built before
  real emitters land. Cover every metric in contract §5.
- Dashboards: **Runner overview** (preview-ready rate and p95 by tier, session start rate,
  error rates, pool gauge against cap, deploy annotations from the `/telemetry/deploy`
  Loki lines), **Tier-2 sessions**, **Tier-1 playground**, **Version health** (framework ×
  `ht_major`, `next` highlighted), **Docs embeds**, **AI assist**, **Observability self**.
  Cost is ADR-0043's; Examples & features is T12's.
- Datasource UIDs and variables consistent across dashboards (environment, time range,
  framework, `ht_major`).
- `pipeline/o11y-dashboards.test.mjs`: every Analytics Engine query uses
  `SUM(_sample_interval * double1)` for counts and a weighted quantile for percentiles,
  only allowlisted functions, only contract columns; every Loki query uses only contract
  labels and names its tenant datasource; no dashboard carries an alert rule.

Out: alert rules (T04, and none in Grafana); the Cost dashboard (T13).

## Acceptance criteria

- `pnpm o11y:dev` plus `node scripts/o11y-seed.mjs` renders every panel non-empty; the
  Outcome has a panel inventory (dashboard, panel, query source) and one screenshot per
  dashboard.
- The lint test fails on a `COUNT()` over Analytics Engine, on an unknown column, and on a
  high-cardinality Loki label.
- After T05–T08 land, the same dashboards render from real local traffic (T11 re-checks).

## Verify

```bash
cd runner
pnpm o11y:dev
node scripts/o11y-seed.mjs
pnpm test
```

## Traps

- Local ClickHouse accepts more SQL than Analytics Engine; a panel that works locally can
  fail in production. The lint test is the gate.
- Provisioned dashboards are read-only by design: UI edits vanish when the box sleeps.
  Export, commit, reload.
- `demo_id`, `session.id` and `cf.ray` never become template variables or Loki labels.

## Outcome

_Filled in when done._
