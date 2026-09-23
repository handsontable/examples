# T01 — Loki + Grafana box image, stop protocol and clean-shutdown marker (spike a)

| | |
|---|---|
| Status | todo |
| Size | L |
| Depends on | — (reads the contract; merges after T00 for the `wrangler.jsonc` scaffold) |
| Blocks | T03, T09, T10 |
| ADR | 0041 §A (box, secrets, stop protocol), §B.4 (Loki config, retention), §H, §L exit criteria 1, 6, 9, 10, 12, 13, 14 |
| Owns | `containers/o11y/**` except `grafana/dashboards/**` (T09) and `waking/` (T03); `workers/o11y/src/box.ts`; the `containers` block of `workers/o11y/wrangler.jsonc`; `pipeline/o11y-box-config.test.mjs` |

## Goal

An image running only Loki and Grafana on a `standard-1` Container pinned to the EU,
with Loki's chunks and index in R2, a stop protocol that ends with a clean-shutdown
marker only after the index is really uploaded, and a local compose everyone else
develops against.

## Read first

- ADR-0041 §A and §B.4; contract §1, §2, §3, §8 (the marker key), §10.
- `containers/live/Dockerfile` for how this repo builds images; do not reuse
  `prepare-container.mjs`.

## Scope

In:

- `containers/o11y/Dockerfile`: pinned Loki and Grafana, a small supervisor, and a
  **shutdown script** that on SIGTERM stops Loki gracefully, confirms the TSDB index for
  the wake is uploaded to R2 (find the observable signal: shipper metrics, upload
  directory empty, or the object listing), then writes `state/wakes/<wakeId>/clean` into
  the **Loki** bucket (the only bucket its credentials reach), then stops Grafana. `wakeId` arrives as an env var at start.
- Loki config exactly as ADR-0041 §B.4: two tenants (`browser`, `worker`),
  `ingester.wal.flush_on_shutdown: true`, `shard_streams.enabled: false`,
  `max_chunk_age: 2h`, `reject_old_samples_max_age: 7d`, `query_ingesters_within: 168h`,
  raised ingestion rate/burst (initial 16/32, T03 tunes), `max_line_size: 256KB`,
  `otlp_config` promoting the contract §3 resource attributes, `max_query_lookback` 30 d /
  90 d per tenant, compactor retention off. S3 endpoint and credentials from env,
  `STORAGE=s3|filesystem`.
- Grafana: sub-path `/grafana/`, `auth.proxy` trusting only `x-o11y-grafana-user` (auto
  sign-up as Viewer), **Live disabled**, provisioning for one Loki datasource per tenant
  (`X-Scope-OrgID`), the Altinity ClickHouse plugin (AE SQL API in production, local
  ClickHouse in dev) with `AE_SQL_TOKEN` from env, an empty dashboards provider for T09.
- `workers/o11y/src/box.ts`: `GrafanaBox` from `@cloudflare/containers`, `standard-1`,
  container `jurisdiction: "eu"` (look up the current wrangler key), `envVars` built from
  Worker secrets at start (never the Slack webhook), a fresh `wakeId` per start recorded in
  `InboxWriter` via T02's API, readiness probes for Loki and Grafana, `stop()` wired to the
  stop protocol, and `onStop` that only records what it was told (T03 does not trust it).
- Local `containers/o11y/compose.yml`: the box, MinIO, ClickHouse with
  `local/clickhouse-init.sql` (contract §4 table). Try Miniflare's local S3 endpoint first;
  say which works.
- R2 lifecycle rule definitions (`browser/` 30 d, `worker/` 90 d, index 90 d, `state/`
  30 d) as a committed JSON file T10 applies.

Out: drain, ledger, wake and Grafana proxy (T03); dashboards (T09).

### Sandbox probe (required — see the board README's probe rules)

Deploy the image to the sandbox account as a throwaway Worker and measure exit criteria
6 (cold start, worst of five), 9 (an idle Grafana tab lets the box stop), 10 (the
Container DO namespace accepts `.jurisdiction("eu")`, instance in an EU region), 12 (what
`onStop` reports for our `stop()`, and whether SIGKILL arrives before the marker), 14
(compressed image size), and criterion 1 on the real platform **with a token scoped to the
Loki bucket only**, proving the box can write its marker in production conditions. Delete everything after.

## Acceptance criteria

- `docker compose -f containers/o11y/compose.yml up` gives Grafana at
  `http://localhost:3000/grafana/` with both Loki datasources and ClickHouse healthy.
- **Exit criterion 1 locally**: push lines to both tenants, SIGTERM the box, restart →
  100 % of lines queryable and the marker present. If Loki does not upload the index on
  graceful shutdown, implement ADR plan B (wait for the next index rotation and its
  upload before writing the marker) and record its duration.
- SIGKILL the box → no marker is written.
- `pipeline/o11y-box-config.test.mjs` pins every §B.4 key and the Grafana sub-path, Live
  and `auth.proxy` settings; each assertion fails when its key is removed.
- Outcome records each probe measurement against its exit-criterion threshold, the local
  boot seconds, memory high-water mark, and the deleted probe resources.

## Verify

```bash
cd runner
docker compose -f containers/o11y/compose.yml up -d
node containers/o11y/local/stop-roundtrip.mjs   # push, SIGTERM, restart, query, check marker
pnpm test
( cd workers/o11y && npx wrangler deploy --dry-run )
```

## Traps

- The container must never be reachable except through the Worker.
- No secret baked into the image.
- Grafana behind a sub-path breaks silently when `root_url` and `serve_from_sub_path`
  disagree.
- `POST /flush` returns before anything is written; it is not evidence of a flush.
- A clean-looking `onStop` (`exitCode: 0`) is also what a host loss reports.

## Outcome

_Filled in when done._
