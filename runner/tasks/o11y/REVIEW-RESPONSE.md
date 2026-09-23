# Response to the second ADR review (2026-09-23)

Each finding → where ADR-0041 revision 3 (or 0042/0043 revision 2) answers it, or why it
was not taken. Section marks refer to ADR-0041 unless stated. Deleted with the task board.

## Point 8 (dedupe) and the Faro findings

| Finding | Answer |
|---|---|
| Different structured metadata defeats dedupe | Accepted; spike question removed. Records are normalised deterministically at ingest (§B.2, §C.2), so a replay carries identical metadata. |
| `faro.receiver` stamps `time.Now()` | Accepted. `faro.receiver` and Alloy leave the design; the Worker converts Faro to OTLP with event-time timestamps clamped to `received_at` ± 5 min (§C.1, §C.2). Exit criterion L.3. |
| Metric queries count two copies inside one chunk | Accepted. Ingest-side 24 h content-hash dedupe (§B.2 steps 2 and 4) plus a per-wake record hash set in the drain (§B.3). Exit criteria L.2, L.4. |
| Ledger does not make replays byte-identical | Accepted. Determinism conditions stated (§B.3 last bullet): event-time timestamps incl. the OTLP zero-time fallback, `shard_streams` off, no re-open across a config or label change. |
| "Until compaction" is wrong | Accepted: "until R2 lifecycle deletes it" (§B.3, Consequences). |

## Partly-landed fixes

| Finding | Answer |
|---|---|
| Spans share the 20 M pool; export is 10 M per signal | Accepted in the facts and in the volume budget (§D, L.8). Traces sampled at 1 % into the dashboard only, no trace export (§C.4). |
| Stale-preview SDK warning; container stdout in API logs | Stale-preview requests answered before the SDK where recognisable; stdout counted in the budget (§D). |
| Maps deleted inside `vite build` | Accepted: the plugin's in-build deletion is turned off; one CI step uploads to Sentry and R2, then deletes (§C.3, Consequences). |
| Flattened `/maps`; 30 releases ≈ 11 days, 360 MB per wake | Gone: symbolication moves into the Worker at drain, maps stay keyed by `<sha>/<original path>`, expire by age with the browser tenant (§C.3). Exit criterion L.5 bounds CPU and memory. |
| Alert cron keeps no state | Accepted: state in DO storage, fire once / resolve once (§F.3). |
| Cloudflare Notifications cannot watch a Worker | Accepted: the API worker's `*/5` cron checks an o11y heartbeat and reports to Sentry (§F.3, §D). |
| `persistent: false` uses `sessionStorage` | Accepted: Faro session tracking disabled; page-load id minted in memory (§C.2, §E.4). |
| Performance and CSP instrumentations send full URLs | Accepted: only errors and web-vitals instrumentations (§E.4). |
| `normalizeMonitorMessage` keeps Babel code frames | Accepted: explicit `stripCodeFrame` in the scrubber (§E.4). |
| No server-side scrubbing; beacon unscrubbed | Accepted: the scrubber is authoritative at ingest for every source (§B.2, §E.4). |
| Fetch catch-all captures every throw; snapshot jobs never rethrow | Accepted: "uncaught" redefined as "escapes a handler", covering both (§E.1). |
| Spend alerts only through `captureMessage` | Accepted: explicitly exempt from the trim (§E.1, §F.3). |
| `Sentry.ErrorBoundary` crashes bypass `onerror` | Accepted: part of "uncaught"; its `onError` also calls the facade (§E.1, §E.2). |
| `recordContainerUsage` hardcodes `container`; single `CF_SCRIPT_NAME`; `SET` upsert | Accepted: SKU parameter, reconcile iterates scripts with distinct SKUs (§G). |
| o11y worker would need D1 and KV | Not needed: the API worker owns D1/KV and records o11y usage over the service binding (§G). |
| An open Grafana tab keeps the box awake | Accepted: Live off, activity renewed only by HTTP requests, 15 min idle stop, 4 h hard limit; "by construction" removed (§A, §G). Exit criterion L.9. |
| `resolveReporting` cannot run server-side | Accepted: server gate is origin/referer host, environment, bot filter, caps, rate limit; webdriver stays browser-side (§B.5, §E.4). |
| ADR-0038's `<script` rule | Accepted: exception extended to `/telemetry/*`; ADR-0038 amended (§B.1, status line). |
| `workers_dev` bypasses the zone rate limit | Accepted: `workers_dev: false`, `preview_urls: false` (§A). |
| Queue rejection reason stale | Reworded: per-message cost and a second write path next to a DO that already batches. |
| Re-open leaned on 0043; "no dependency on the platform" wrong | Accepted: re-open lives on `/grafana/_o11y/reopen` (§B.1, §B.3); 0042 ships with 0041 and depends on it; 0043 follows after launch (§J). |

## New problems in B.2/B.3

| Finding | Answer |
|---|---|
| `POST /flush` is not a flush marker; index head uploads every 15 min; loss is the whole wake; `onStop` cannot tell a host loss | Accepted. Clean-shutdown marker written by the container after Loki stops and the index is uploaded; keys stay provisional until the marker appears, otherwise re-opened (§A stop protocol, §B.3). Loss of an unclean stop = a replay of that wake, stated. Exit criteria L.1 (with plan B), L.2, L.12. |
| `max_chunk_age` set two ways; out-of-order window premise | Resolved: one value (2 h); re-opened keys replay first into an empty ingester, in key order; `400 too_far_behind` marks the key `rejected` and alerts instead of recording success (§B.3, §B.4). |
| Config key name; retention markers on local disk | Accepted: `ingester.wal.flush_on_shutdown`; retention by R2 lifecycle per tenant prefix plus `max_query_lookback`, compactor retention off (§B.4). Exit criterion L.13. Approved retention numbers kept via two tenants. |
| Push limits; `faro.receiver` rate limit, 202-on-failure, 2 s drop | Loki limits raised, requests ≤ 1 MB, only `2xx` ledgers (§B.3, §B.4); `faro.receiver` gone. |
| `query_ingesters_within` hides backfill | `168h` (§B.4). |
| SQLite 2 MB rows; `<seq>` unspecified | Rows ≤ 1 MB after normalisation, records > 256 KB dropped; `<seq>` persisted and incremented in the same transaction, zero-padded to 12 (§B.2). |
| Trace bodies hold URLs, UA, geo, preview tokens; "traces prefix" impossible | No trace export at all until Tempo, which returns with a span-attribute allowlist (§C.4). |
| Writer cannot know backlog | Ledger moved into `InboxWriter`; `backlog()` readable without the container (§B.3, §A). |
| Drain `stop()` SIGTERMs a Grafana user | Stop only if no Grafana request in 10 min (§A). |
| How secrets reach the box | Container `envVars` from Worker secrets; Slack stays in the Worker (§A). |
| No `http.request` point; per-embed alert needs demo id | `api.request` and demo-id blobs in the catalogue (§D, §F.2, §F.3). |
| No scheduler for the 5-min gauge | API worker `*/5` cron (§D). |
| AE samples at write time; false "new fingerprint" | Exact first-seen registry in `InboxWriter` (§B.2, §F.3). |
| `persist: true` and Sentry are not EU | Stated plainly in §H; `persist` goes off 30 days after acceptance. |

## ADR-0042, ADR-0043, docs

| Finding | Answer |
|---|---|
| `forked_from` exists | Accepted: no migration (0042 §3). The exact docs format and completeness date are left for the implementing task to confirm; the review's 2026-07-17 is not verified yet. |
| Referrer classes cannot work | Accepted: removed; `entry` derived in-app (`deep-link` vs `picker`…). 0041's embed row lost its docs path too (§C.5, §F.2). |
| `example.*` in Loki for 30 days | Accepted: AE only, never inboxed (0042 §1, 0041 §B.2). |
| Rollup has no key, re-run semantics or window | Primary key, previous full UTC day, `INSERT OR REPLACE` (0042 §5). |
| 20 of 20 blobs | Contract now leaves four unassigned; 0042 takes three (`kind`, `ref`, `area`), one stays free (0042 §4). |
| Dashboard needs D1 | AE-only dashboard for three months; long range waits for 0043 (0042 §6). |
| 0043 internal marker unspecified | `WorkerEntrypoint` RPC `AdminReads`, not HTTP (0043 §1). |
| Infinity can POST anywhere | Allowlisting forwarder, GET only, allowed-hosts restricted (0043 §2). |
| Tier-history gauge missing | `budget.gauge` added to 0041 §D, §F.2. |
| Comparison week tests parsing, no criterion | Replaced by a per-panel equivalence test plus one spot check (0043 §5). |
| `GET /api/admin/settings` missing; "three writes" | Inventory table corrected (0043 Context). |
| `at_capacity` D1 counter contradiction | Resolved: ADR-0040 C.1 stands; cost-guardrails.md and AGENTS.md updated. |
| D1 jurisdiction check moot | Accepted: stated in §H. |

## Unknowns → exit criteria

Uncaught export with invocation logs off → L.11 (and made moot by our own structured
lines, §D). `onStop` for our `stop()` and SIGKILL escalation → L.12. Retention across
short wakes → L.13. Live WebSocket → L.9. Export timestamps and attributes → handled by
the ingest fallback and resource-attribute hoisting (§B.2, §C.2), verified by L.3.
Drain-wake duration → L.7 with a threshold. Image size → L.14 (Alloy's removal shrinks it;
no estimate is claimed). Event-time and dedupe now gate acceptance (L.2–L.4), not only
the spikes.

## Planning deltas D1–D13

All folded into revision 3: D1 fixtures (§I), D2 ClickHouse shim (§I), D3 per-stream
keys (superseded: per-tenant keys, no trace stream, §B.2), D4 re-open route (§B.1),
D5 local path (§E.4), D6 launch path (constraint 7), D7 pseudonym (§C.2), D8 loss window
(superseded by the clean-shutdown marker, §B.3), D9 Cost to 0043 (§F.2), D10
fingerprint exclusion (§F.3), D11 Sentry switch (§E.3), D12 0042 ships (§J), D13 probes
(§L).

## Found in the final self-check

- The clean marker lives in the Loki bucket, whose token the box already has; the Worker
  reads it through `O11Y_LOKI_STATE` (§A, contract §2). Criterion 1 must pass with the
  production-scoped token.
- Dedupe hashes the decoded, scrubbed record before any arrival-time value is stamped;
  the arrival time never enters a stored record (§B.2, contract §8).
- A wake is "over" when a newer wake started or the container state says not running;
  `backlog()` counts only `written` keys (§B.3).
- Decoding and scrubbing run in the stateless route handler; the drain is a bounded DO
  alarm loop under `limits.cpu_ms`, and criterion 7 records CPU (§B.2, §B.3, L.7).
- ADR-0042's `area` gets `blob19` and an `example_daily` column; `lang` dropped as
  redundant with `framework`.
- Deploy order for the mutual service bindings: o11y first, then API (§H, T10).

## Verification round (2026-09-23)

| Item | Answer |
|---|---|
| No check that `hot.*` arrive as labels | Exit criterion 15 and a §K label test; T02 (precondition, probe), T03 (series API check). |
| Wrong reference for `navigator.webdriver` | §E.4. |
| Browser index outlives browser chunks | Stated in §B.4: `max_query_lookback: 30d` keeps queries off those entries; the index is not split. |
| "Exports nothing" vs `o11y.*` points | §B.6 reworded: no Workers Logs, no traces; self-metrics go to Analytics Engine without passing its own ingest. |
| AE 10 M figure missing; no contract link | Back in Context; the contract is linked from §C.2 and §F.1. |
| $10 ceiling vs $15 cap | Explained in §G. Found while answering: a pause longer than 7 days loses the oldest log text (inbox lifecycle and Loki's `reject_old_samples_max_age`); §G now says so instead of "nothing is lost". |

## Reversals of earlier agreements, for the owner

1. Revision 2 kept Faro payloads as-is for `faro.receiver`; revision 3 drops
   `faro.receiver` and Alloy and converts in the Worker, which means owning a converter
   and a symbolicator.
2. `session.id` becomes a page-load id, not a Faro session.
3. Retention numbers (30 d browser, 90 d worker) are unchanged, but enforced by R2
   lifecycle on two Loki tenants instead of Loki's compactor.
