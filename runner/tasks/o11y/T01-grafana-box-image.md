# T01 — Loki + Grafana box image, stop protocol and clean-shutdown marker (spike a)

| | |
|---|---|
| Status | done |
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

Both phases complete. Full narrative, all commands/outputs and the two
review rounds' findings are in `.superpowers/sdd/README/T01-report.md`
(outside this directory, per COMMON.md — this section is the condensed
record).

### Phase 1 — box image, stop protocol, local compose

`containers/o11y/**` (Dockerfile, bash supervisor, Loki/Grafana config,
`compose.yml` with MinIO+ClickHouse, `r2-lifecycle-rules.json`,
`local/stop-roundtrip.mjs`) and `pipeline/o11y-box-config.test.mjs`. Two
review rounds (an advisor pass, then an external opus review) found and
fixed real bugs before this was accepted — notably C1: the index-upload
check originally only asked "does an uploader-named object exist", which
passes-open on a mid-wake periodic upload masking a failed final one;
fixed to diff a pre-SIGTERM snapshot, proven both ways (a seeded fake
object + a MinIO policy denying only `index/*` writes correctly refuses
the marker; the identical scenario against the reverted pre-fix logic
incorrectly writes one). Local measurements: compressed image 203.3 MB
(amd64: 212.9 MB, see phase 2); local boot ~16 s; SIGTERM→exit ~2.2 s;
100% of pushed lines queryable after a genuinely fresh container restart
(no volume); SIGKILL writes no marker, data genuinely lost. 26 (phase 1) +
7 (fix round 1) = 33 mutation-evidence cases, every pinned config
assertion verified to fail when its key is removed/changed.

### Phase 2 — `box.ts`, the `containers` block, the sandbox probe

**`GrafanaBox`** (`workers/o11y/src/box.ts`): `wake(reason)` is the only
start path — mints a wakeId, persists it to `ctx.storage` (survives a DO
eviction), calls `InboxWriter.recordWake` **before** `start()` (fails
closed on rejection), latches an in-flight promise **synchronously**
(caught a real concurrent-call race in `pipeline/o11y-box.test.mjs` before
it shipped — see the report). `containerFetch` is overridden to (a) refuse
`/api/live/*` / `/grafana/api/live/*` / any percent-encoded or
double-slash variant / any `Upgrade: websocket` request with 404 before
touching the container (the controller's I1 ruling — required, not
optional: re-verified with a real Centrifuge protocol frame that a raw
client still gets a full connection regardless of `max_connections`), and
(b) refuse with 503 rather than auto-start when not running — the
base class's own `containerFetch` auto-starts on any request, which is the
compose.yml `WAKE_ID` bug one layer up. `isReady()` checks real HTTP 200s
(`/ready`, `/grafana/api/health`), not just the base class's
"didn't throw" port check. `onStop` records exactly what the platform
reported (wakeId, exitCode, reason) and claims nothing about cleanliness.
`stop()` is left as the inherited default (sends SIGTERM, which
`shutdown.sh` traps). `envVars` are rebuilt from scratch every start
(never merged with a prior call), fail closed when `LOKI_S3_*` or
`CLOUDFLARE_ACCOUNT_ID` are missing, never include `SLACK_WEBHOOK_URL`,
and the only `GF_*` var is `GF_SERVER_ROOT_URL`. Production ClickHouse
envVars use the single `Authorization: Bearer ${AE_SQL_TOKEN}` header
shape (T01-D5); boot-tested locally with that exact shape (empty
`O11Y_CLICKHOUSE_DATABASE`/`HEADER2_NAME`/`HEADER2_VALUE` included) —
Grafana provisions cleanly.

**`wrangler.jsonc`**: added the `containers` block (`class_name:
GrafanaBox`, `image: ../../containers/o11y/Dockerfile`, `instance_type:
standard-1`, `max_instances: 1`, `constraints.jurisdiction: "eu"` — the
schema key, found by reading `wrangler@4.136.3`'s own
`config-schema.json`, not guessed). `scheduling_policy` deliberately left
unset (T01-D6). Added `vars.CLOUDFLARE_ACCOUNT_ID` (T01-D4) since `box.ts`
needs the account id at runtime (R2 S3 endpoint, AE SQL API URL) and a
Worker has no other way to read its own account id.

**Tests**: `pipeline/o11y-box.test.mjs` (new, 14 cases) drives the real
`GrafanaBox` under `node --test` via a structural `@cloudflare/containers`
stub (`pipeline/fixtures/cloudflare-containers-stub.mjs`) and a
`.js`→`.ts` resolve hook (`pipeline/fixtures/o11y-worker-hooks.mjs`) — the
same pattern `mcp-routes.test.mjs` uses for the API worker. Covers:
distinct wakeIds per cycle with the envVars always carrying the new one;
idempotency while running (no second `recordWake`); the concurrent-call
race (caught a real bug — see above); `recordWake` rejecting blocks
`start()`; missing `LOKI_S3_*` refuses to start; no `SLACK_WEBHOOK_URL` /
exactly one `GF_*` key; the production ClickHouse header shape; every live
path variant + websocket upgrades 404 without starting the container;
a non-live path proxies once running; no auto-start on an unrelated
request; `onStop` records what it received, identically for a stop() and
a (simulated) host loss. `pipeline/o11y-box-config.test.mjs` gained 2
tests pinning the `containers` block (class_name, instance_type,
max_instances, jurisdiction, and that `image` resolves to a real,
exact `containers/o11y/Dockerfile` — via a zero-dependency, string-aware
JSONC comment stripper) and `CLOUDFLARE_ACCOUNT_ID`'s presence/parity with
`account_id`.

### Sandbox probe — measurements against the real platform

Deployed `o11y-probe-t01` (Worker + `GrafanaBox` DO/Container +
`ProbeInboxWriter`, a recording stand-in for T02's still-throwing real
`InboxWriter`) to the sandbox account (`e17e41cc82bda15dfa63960aa172fb87`)
via a throwaway `wrangler.probe.jsonc` + `probe-index.ts`, **neither
committed** — both deleted after measurement; full contents are in the
report. Every probe route gated by a shared secret header.

| Criterion | Threshold | Result |
|---|---|---|
| 6 — cold start | ≤ 90 s, worst of 5 | **46.5 s worst** (25.6, 29.3, 29.0, 46.5, 44.9 s), confirmed "stopped" between each run |
| 9 — idle tab | stops at 15 min idle | **stopped after 1059 s (17.65 min)** with zero requests made during the wait (state polling used `getState()` only, which never touches `containerFetch`/the activity timer) |
| 10 — EU placement | `.jurisdiction("eu")` accepted, instance in an EU region | Accepted; `wrangler containers instances` showed `LOCATION: mxp04` (Milan) — EU |
| 12 — stop semantics | `onStop` report recorded; no SIGKILL before the marker for a Worker-initiated stop | `stop()`: exit in 5 s (a separate earlier run: 53.7 s — see T01-D8), `onStop → {exitCode:1, reason:"exit"}` (index upload correctly failed closed — see T01-D7). **`destroy()` (SIGKILL): `onStop → {exitCode:0, reason:"exit"}`** — empirically confirms ADR-0041 §A's own claim that a host loss is indistinguishable from a clean exit at the `onStop` layer; the marker, never `onStop`, is what the ledger must trust. Platform's own documented SIGTERM→SIGKILL grace: **15 minutes** (developers.cloudflare.com/containers/concepts/architecture/), far above this box's own ~30–45 s internal grace, so the platform is never the constraint |
| 14 — image size | ≤ 1 GB compressed | **212.9 MB** (linux/amd64, `docker buildx build --platform linux/amd64`, the real target platform — not the 203.3 MB arm64 local-dev number) |
| 1 — clean stop, production-scoped token | 100% queryable + marker, **production-scoped R2 token** | **Not measured with a production-scoped token — see T01-D7.** Loki push (204), Grafana health/live-block, and R2 lifecycle-rule apply-and-read-back all verified against the real platform; local criterion 1 (Phase 1, MinIO, exact-line-set + SIGKILL negative control) still stands as the only full round-trip evidence |
| 13 (config half) | R2 lifecycle rules file applies | `wrangler r2 bucket lifecycle set --file r2-lifecycle-rules.json` on the probe bucket, read back via `lifecycle list`: all 4 rules present with the right prefixes/ages — the same file T10 applies to the real bucket |

### Deviations

- **T01-D4 — `vars.CLOUDFLARE_ACCOUNT_ID` added to `env.ts`/`wrangler.jsonc`
  (phase 2).** A Worker cannot read its own account id at runtime;
  `box.ts` needs it to build the Loki bucket's R2 S3 endpoint and the AE
  SQL API URL. Minimal, justified touch of T00's scaffold files per
  COMMON.md — the contract doc itself was not touched.
- **T01-D5 — production ClickHouse envVars use
  `Authorization: Bearer ${AE_SQL_TOKEN}`, `O11Y_CLICKHOUSE_HEADER2_*` and
  `O11Y_CLICKHOUSE_DATABASE` empty.** Matches
  `datasources.yaml`'s env-driven header-name-and-value design from fix
  round 1. Boot-verified locally with this exact shape (previously flagged
  as untested) — Grafana provisions cleanly with empty `httpHeaderName2`
  and `defaultDatabase`.
- **T01-D6 — `containers[].scheduling_policy` left unset.** Cloudflare's
  own "Get started" example for a Durable-Object-managed container omits
  it; both `wrangler deploy --dry-run` and the real sandbox deploy
  resolved it to `"default"` without complaint, and the deployed
  application worked end to end (wake, stop, destroy, live-block, EU
  placement all confirmed). No evidence `"durable_object"` is required for
  this pattern in the current wrangler/platform version.
- **T01-D7 — criterion 1 not re-proven on the real platform with a
  production-scoped R2 token.** Attempted to mint one per the task's own
  instruction: both the generic Cloudflare API token-creation endpoint
  (`POST /accounts/{id}/tokens`) and even listing existing tokens
  (`GET /accounts/{id}/tokens`, `GET .../tokens/permission_groups`)
  returned `9109: Unauthorized to access requested resource` — tried via
  both the Cloudflare MCP tool's own OAuth grant and wrangler's separately
  stored OAuth token (a broader grant that could create R2 buckets and
  deploy Workers/Containers, but still lacks `token:write`/`r2:write` on
  this account). Recorded exactly what failed rather than substituting a
  broad key and calling it production-scoped, per the task's own
  instruction. Consequence: the sandbox `GrafanaBox` ran with dummy
  `LOKI_S3_ACCESS_KEY_ID`/`SECRET`, so every index-upload attempt failed
  closed by design (no marker ever written, `onStop` correctly reported
  `exitCode:1` for a Worker-initiated `stop()`) — this is *evidence the
  fail-closed design holds under real Cloudflare Container conditions*,
  not merely local Docker, but it does not reprove the full clean-marker
  round trip on the real platform. That remains local-only evidence
  (Phase 1). Whoever picks up a follow-up token-minting task needs either
  an account owner with `Edit API Tokens` (or the dashboard UI) on the
  sandbox account, or a differently-scoped credential.
- **T01-D8 — `stop()` timing varied 5 s vs. 53.7 s across two sandbox
  runs**, both with the same failing (dummy-credential) index-upload path.
  Not investigated further within phase 2's scope — plausibly S3
  connect/retry timing variance against a real (if credential-rejecting)
  R2 endpoint vs. whatever failed faster the other time. Both are well
  under the platform's 15-minute SIGTERM grace and this box's own internal
  bound; noted for whoever tunes `O11Y_STOP_GRACE_SECONDS` against
  production traffic (ADR-0041 exit criterion 7).

### Sandbox resources created and deleted

All under the sandbox account (`e17e41cc82bda15dfa63960aa172fb87`),
prefixed `o11y-probe-t01`, all confirmed deleted after measurement:

- Worker `o11y-probe-t01` (`wrangler delete`) — confirmed gone (`404` on
  its `workers.dev` URL afterward).
- Container application `o11y-probe-t01-grafanabox`
  (`wrangler containers delete`) — confirmed gone from
  `wrangler containers list` afterward.
- Registry image `o11y-probe-t01-grafanabox:3a0b92d6`
  (`wrangler containers images delete`) — confirmed gone from
  `wrangler containers images list` afterward.
- R2 bucket `o11y-probe-t01-loki` (EU) (`wrangler r2 bucket delete`) —
  the delete itself is proof it held zero objects (a non-empty bucket
  refuses deletion); confirmed gone from a `--jurisdiction eu` bucket
  list afterward.
- 3 Worker secrets (`LOKI_S3_ACCESS_KEY_ID`, `LOKI_S3_SECRET_ACCESS_KEY`,
  `AE_SQL_TOKEN`, all dummy values) — removed with the Worker.
- No API token was created (T01-D7) — nothing to delete there.
