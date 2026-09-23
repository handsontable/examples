# T02 — o11y Worker ingest: routes, gates, normalisation, `InboxWriter` (spike b, part 1)

| | |
|---|---|
| Status | todo |
| Size | L |
| Depends on | T00 |
| Blocks | T03, T04, T08, T09 (fixtures), T12, T11 |
| ADR | 0041 §B.1, §B.2, §B.5, §B.6, §C.1, §C.2, §E.4 (server scrub), §F.1; exit criteria 3, 4 |
| Owns | `workers/o11y/src/{index.ts,router.ts,gates/**,normalise/**}`, `workers/o11y/src/inbox/{writer.ts,pack.ts,dedupe.ts,registry.ts}`, the DO/R2/AE/rate-limit parts of `workers/o11y/wrangler.jsonc`, `pipeline/o11y-{routes,gates,normalise,inbox}.test.mjs`, `pipeline/fixtures/otlp/**`, `pipeline/fixtures/faro/**`, `scripts/o11y-replay-fixtures.mjs` |

## Goal

Every telemetry route authenticates or drops its input, normalises it into scrubbed,
deterministic OTLP log records with event-time timestamps, drops duplicates, commits to
durable storage before answering, and packs ordered per-tenant R2 objects — with the box
asleep.

## Read first

- ADR-0041 §B and §C; contract §1, §2, §3, §5, §6, §8.
- `workers/api/src/analytics.ts` (bot filter, classifiers — moved to the contract module
  by T00) and `packages/runtime/src/monitor.ts` (`redactPreviewHosts`).

## Scope

In:

- `router.ts` with `registerRoute(method, path, handler)` so T03, T04, T08 plug in.
- `gates/` per ADR §B.5: origin/referer host + environment gate (production host only;
  `localhost` only when `O11Y_ENV = local`), `BOT_RE`, size caps, item-kind allowlist,
  the Workers rate-limiting binding; `x-o11y-secret` (constant-time); GitHub OIDC with
  `jose`; Sentry HMAC; the Access JWT helper exported for T03. Every drop writes an
  `o11y.ingest` point with its reason.
- `normalise/`, in the **stateless route handler** (never inside `InboxWriter`), in the ADR
  §B.2 order — decode and scrub, **hash**, then stamp timestamps:
  - Faro payload → OTLP log records (contract §6 mapping), `session.id` from the item,
    timestamps clamped to the arrival time ± 5 min after hashing;
  - Cloudflare export → decode protobuf or JSON (both, until the probe shows which is
    sent), keep allowlisted attributes, drop `url.full`, user agent, geo and ASN,
    `redactPreviewHosts` over bodies and attributes, timestamp fallback chain
    `time_unix_nano` → `observed_time_unix_nano` → `received_at`;
  - hoist `hot.*`, `service.*` and `deployment.environment.name` to resource
    attributes; run `scrubTelemetry` authoritatively; drop records over 256 KB;
  - deploy events and Sentry issue webhooks → one OTLP log record each (`worker` tenant).
- `inbox/`: the `InboxWriter` DO (`main`, EU): dedupe of the hashes the route computed
  over 24 h (`o11y.ingest` outcome `duplicate`), append to storage rows ≤ 1 MB with the
  arrival time on the row (never in the record), answer after commit,
  60 s / 4 MB alarm packing one gzipped object per tenant, `seq` persisted in the same
  transaction as `key:<key> = written`, the exact fingerprint registry (`fp:*`), the
  heartbeat `lastIngest`. Analytics Engine extraction per contract §6 at this step;
  `example.*` events produce points only and are never stored.
- Fixtures: hand-built OTLP bodies (protobuf and JSON, including zero timestamps and
  forbidden attributes), Faro payloads (exception with a code frame, measurement, web
  vitals, `example.open`, a log), a deploy event, a Sentry issue payload; the replay script.

Out: beacon conversion (T08, via `registerRoute` and this task's converter), the ledger
transitions and drain (T03), alerts (T04).

### Sandbox probe (required — see the board README's probe rules)

A throwaway Worker on the sandbox account exporting logs to a throwaway copy of these
routes. Record content type, body sizes, batches per minute under synthetic load, whether
records carry `time_unix_nano`, which attributes arrive and where (resource vs record),
and the exporter's behaviour on a forced 5xx and a forced timeout. Then check exit
criterion 15 on those real bodies: after normalisation, every contract label reaches
Loki (spin up the local box against the captured fixtures) and no metadata-only field
becomes a label. Capture, scrub and
commit bodies as fixtures. Delete the probe.

## Acceptance criteria

- Replaying every fixture against `wrangler dev` returns 2xx only after the storage
  commit; after the alarm, local R2 holds per-tenant objects with strictly increasing
  keys; every line is a valid OTLP `ResourceLogs` with the contract resource attributes.
- **Exit criterion 3 at ingest**: stored timestamps equal the fixture's event time,
  clamped for browser items; a zero-timestamp OTLP record gets its fallback.
- **Exit criterion 4**: the same export body posted twice, seconds apart and including a
  zero-timestamp record, yields one stored copy and one `duplicate` point.
- No stored record contains a query string, a user agent, a Babel code frame, a preview
  hostname, `url.full`, geo or ASN (assert over all fixtures).
- A simulated restart between an append and the alarm loses nothing.
- An `example.open` Faro event produces one Analytics Engine point and no stored record.
- Every stored record carries the contract §3 keys as **resource** attributes, never as
  record attributes (the precondition for exit criterion 15).
- Each gate test fails when its gate is bypassed.

## Verify

```bash
cd runner
pnpm test
( cd workers/o11y && npx wrangler dev ) &
node scripts/o11y-replay-fixtures.mjs --base http://localhost:8788
( cd workers/o11y && npx wrangler deploy --dry-run )
```

## Traps

- Keys come only from the writer's persisted `seq`, never from `Date.now()` in a route.
- DO SQLite rows cap at 2 MB; keep rows ≤ 1 MB.
- `CompressionStream` output must be fully read before `put`.
- Jurisdiction is not enforced locally; a green local run is not evidence of EU placement.
- ADR-0038's WAF rule 403s bodies containing `<script` until T10 extends the exception to
  `/telemetry/*`; the sandbox probe zone may behave differently from production.

## Outcome

_Filled in when done._
