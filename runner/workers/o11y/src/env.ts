// Bindings, vars and secrets (observability contract §2). Every name here
// is the contract — a typo becomes every later task's typo.
//
// `InboxWriterApi` is COMMON.md's pinned cross-task interface 1: the real
// `InboxWriter` DO lives in `inbox/writer.ts`; `GrafanaBox` (`box.ts`) calls
// `recordWake` at container start.

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { AlertState, Heartbeat, NormalisedRecord, Tenant } from "@handsontable/demo-runtime/telemetry";
import type { GrafanaBox } from "./box.js";
import type { InboxWriter } from "./inbox/writer.js";

/** One item the route handler hands to `InboxWriter.ingest` after ADR §B.2
 * steps 1–3. `hash` is computed over the pre-stamp record so a redelivered
 * body hashes identically. `fingerprint` is set only for records that feed
 * the new-fingerprint alert (§7). `record` is optional: absent for an
 * `example.*` Faro event, which still runs the hash/dedupe transaction but
 * is never stored (§6).
 */
export interface IngestItem {
  hash: string;
  record?: NormalisedRecord;
  fingerprint?: string;
}

export type IngestOutcome = "accepted" | "duplicate";

export interface IngestItemResult {
  hash: string;
  outcome: IngestOutcome;
}

export interface IngestResult {
  /** Index-aligned with `items`: `results[i]` is the outcome of `items[i]`.
   *  Callers must match by index, never by `hash` — two items can share a
   *  hash and get different outcomes. */
  results: IngestItemResult[];
}

/** `InboxWriter`'s RPC surface, pinned by the controller (COMMON.md
 * interface 1). Further methods are added on this same interface. */
export interface InboxWriterApi {
  /** Writes contract §8 `wake:<wakeId> = { startedAt, reason, over: false }`
   *  and marks every earlier wake `over: true`. Called by `GrafanaBox` at
   *  container start. */
  recordWake(wakeId: string, reason: "backlog" | "visit"): Promise<void>;

  /** Stores `readyMs` (wake-to-ready, ms) on `wake:<wakeId>`, first call
   *  wins. `resolveWakes` carries it into the `o11y.wake` point. */
  recordWakeReady(wakeId: string, readyMs: number): Promise<void>;

  /**
   * ADR §B.2 steps 4–5: dedupe each item's `hash` against the 24h window,
   * append non-duplicate items to storage rows, update the fingerprint
   * registry and `heartbeat.lastIngest`, commit atomically. Returns the
   * per-item outcome for the route's aggregated `o11y.ingest` point.
   */
  ingest(tenant: Tenant, arrivalMs: number, items: IngestItem[]): Promise<IngestResult>;

  // ---- Alerts, watchdog, the o11y spend cap ------------------------------
  // Contract §8's alert/drainsPaused/heartbeat keys are read/written only
  // through these methods, never touched directly elsewhere.

  /** `lastIngest` is stamped by `ingest()`; `lastCron` by
   *  `stampCronHeartbeat`, called once per tick from `index.ts`'s merged
   *  `scheduled()` export. */
  heartbeat(): Promise<Heartbeat>;
  /** Sets `heartbeat.lastCron` to `nowMs`, preserving `lastIngest`. Proves
   *  cron liveness the same way `ingest()` already proves it for
   *  `lastIngest` — never called from an ingest route. */
  stampCronHeartbeat(nowMs: number): Promise<void>;

  /** Oldest still-`written` inbox key's age, or `null` if empty. Derived
   *  from the key's hour bucket, taken as end-of-hour — a lower bound, so
   *  the backlog alert can only fire late, never early. */
  backlogOldestAgeMs(): Promise<number | null>;
  /** Count of `key:<k> = rejected:<reason>` entries — informational total,
   *  used in the alert's own detail text. */
  rejectedKeyCount(): Promise<number>;
  /** Logs a rejection EVENT for a key that stays `provisional`/`done:`
   *  overall but had one chunk permanently rejected — see
   *  `ledger.ts#recordPartialReject`. */
  recordPartialReject(key: string, reason: string): Promise<void>;
  /** Count of rejection EVENTS newer than `sinceMs` — the rejected-key
   *  alert fires on this, not the never-pruned total, so it can resolve. */
  recentRejectionCount(sinceMs: number): Promise<number>;

  /** `fp:<fingerprint>` entries via the `fpts:` time-ordered index, after
   *  `afterKey` — a KEYSET cursor (a ms-only cursor would stall once one ms
   *  holds `NEW_FINGERPRINT_SCAN_LIMIT`+ entries). `null` means no cursor
   *  yet; the scan starts after `fallbackSinceMs`. `truncated` means more
   *  may exist past the last entry read. */
  newFingerprintsAfterKey(
    afterKey: string | null,
    fallbackSinceMs: number,
  ): Promise<{ entries: { key: string; name: string; firstSeenMs: number }[]; truncated: boolean }>;

  /** `alert:<rule>` (§8): the exact fire-once/resolve-once state the ADR
   *  §F.3 rule evaluator reads and writes every tick. */
  alertState(rule: string): Promise<AlertState | undefined>;
  setAlertState(rule: string, state: AlertState): Promise<void>;

  /** Small scalar bookkeeping beyond `firing`/`resolved` — lives under its
   *  own `alertMeta:<key>` prefix, not `AlertState`. */
  getAlertMeta(key: string): Promise<string | undefined>;
  setAlertMeta(key: string, value: string): Promise<void>;

  /** `drainsPaused` (§8, ADR §G): set when the spend cap is crossed. The
   *  wake path refuses a *backlog* wake while paused; a Grafana visit wake
   *  is unaffected by design. */
  drainsPaused(): Promise<boolean>;
  setDrainsPaused(paused: boolean): Promise<void>;

  // ---- Ledger / backlog: real logic in `inbox/ledger.ts` (pure); these RPC
  // methods (`inbox/writer.ts`) wire it against real storage/R2/the
  // `GrafanaBox` stub. --------------------------------------------------

  /** ADR §B.3: resolves every wake that still owns provisional keys and is
   *  over — a newer wake started, or the box is observed not running.
   *  Called at every cron tick and at the start of each wake. */
  resolveWakes(): Promise<void>;

  /** `written` keys only, after running {@link resolveWakes} first. The
   *  cron reads this to decide whether to wake the box, never while
   *  `drainsPaused`. */
  backlog(): Promise<{ oldestWrittenAgeMs: number; totalBytes: number; writtenCount: number; drainsPaused: boolean }>;

  /** Up to `limit` `written` keys, in key order (re-opened keys sort first —
   *  see `ledger.ts#nextWrittenKeys`'s doc comment for why DRAIN ORDERING
   *  needs no separate "re-opened" flag). The drain's own batch source. */
  nextWrittenKeys(limit: number): Promise<string[]>;

  /** Consumes (reads AND clears) the one-shot reopen markers
   *  `reopenWindow` left for `inboxKeys`, so `box.ts#drainStepBody` can
   *  emit `reason: "reopen"` on its `o11y.drain` point. */
  takeReopenedFlag(inboxKeys: string[]): Promise<boolean>;

  /** A key becomes `provisional(wakeId)` only after every one of its
   *  requests to Loki returned `2xx` (ADR §B.3). */
  markKeysProvisional(wakeId: string, keys: string[]): Promise<void>;

  /** Commits a key straight `written` → `done:` with no wake/marker
   *  involved — only valid when the drain pushed zero bytes. */
  commitKeys(keys: string[]): Promise<void>;

  /** A `400` from Loki (e.g. `too_far_behind`) marks the key `rejected` with
   *  Loki's own message (ADR §B.3) — never retried by a later wake. */
  rejectKey(key: string, reason: string): Promise<void>;

  /** `POST /grafana/_o11y/reopen`'s own logic (ADR §B.3/§J): re-opens every
   *  key whose inbox-key hour bucket overlaps `[fromMs, toMs)`, except a key
   *  the CURRENT wake still owns provisionally. */
  reopenWindow(fromMs: number, toMs: number): Promise<{ reopened: number }>;

  /** The current not-over wake's id, or `null`. Used by the reopen route
   *  (to protect an in-flight drain) and by `GrafanaBox`'s drain/stop
   *  orchestration. */
  currentWakeId(): Promise<string | null>;
}

export interface Env {
  INBOX_WRITER: DurableObjectNamespace<InboxWriter>;
  GRAFANA_BOX: DurableObjectNamespace<GrafanaBox>;

  O11Y_INBOX: R2Bucket;
  O11Y_LOKI_STATE: R2Bucket;
  O11Y_MAPS: R2Bucket;

  RUNNER_EVENTS: AnalyticsEngineDataset;

  /** `handsontable-demos-api` — o11y usage metering, o11y spend, later
   *  `AdminReads` (ADR-0043). */
  API: Fetcher;

  O11Y_ENV: "production" | "local";
  /** The Handsontable login broker's base URL (ADR-0007, ADR-0041 §B.5/§H).
   *  Read only by `gates/broker.ts` and `grafana/login.ts`'s `/login`
   *  redirect; `gates/session.ts` never calls the broker. */
  LOGIN_BROKER_URL: string;
  GITHUB_OIDC_REPOSITORY: string;
  /** ADR §B.5's `deploy` row: GitHub's OIDC `workflow_ref` claim, exact
   *  match `<owner>/<repo>/<workflow path>@<ref>`. */
  GITHUB_OIDC_WORKFLOW_REF: string;

  /** The `o11y.ingest` self-metric needs the worker's own `service.version`
   *  (contract §2). Optional — falls back to `"dev"`. */
  SERVICE_VERSION?: string;

  /** Duplicates wrangler.jsonc's `account_id` — `GrafanaBox` needs it to
   *  build the Loki R2 S3 endpoint and the Analytics Engine SQL API URL
   *  (ADR-0041 §A). */
  CLOUDFLARE_ACCOUNT_ID: string;
  /** The Loki bucket name `GrafanaBox` writes to. Optional — falls back to
   *  the production bucket, so a sandbox probe can point at its own bucket
   *  instead of silently targeting production. */
  LOKI_S3_BUCKET?: string;

  /** Local-mode Analytics Engine SQL API stand-in (contract §10).
   *  `.dev.vars` only. Defaults to `http://localhost:8123` — see
   *  `alerts/ae-query.ts`. */
  RUNNER_EVENTS_CLICKHOUSE_URL?: string;

  /** Local-only host port for `compose.yml`'s `minio`/`clickhouse`
   *  services, reached via `host.docker.internal`. Meaningful only under
   *  `O11Y_ENV === "local"`. */
  O11Y_LOCAL_MINIO_PORT?: string;
  O11Y_LOCAL_CLICKHOUSE_PORT?: string;
  /** The origin `wrangler dev` is actually reachable on, for Grafana's
   *  own `GF_SERVER_ROOT_URL` — local-only. */
  O11Y_LOCAL_PUBLIC_ORIGIN?: string;

  // Optional secrets: a required field would force `wrangler dev` to
  // typecheck against `.dev.vars`-only values. Every gate that reads one
  // must fail closed when it is absent.
  O11Y_EXPORT_SECRET?: string;
  SENTRY_HOOK_SECRET?: string;
  AE_SQL_TOKEN?: string;
  LOKI_S3_ACCESS_KEY_ID?: string;
  LOKI_S3_SECRET_ACCESS_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  /** The HMAC key for the Worker's own session cookies (`gates/session.ts`).
   *  Optional — a gate must fail closed when absent. Rotating it logs every
   *  signed-in person out at once. */
  O11Y_SESSION_SECRET?: string;

  /** `.dev.vars` only — fail-closed local bypass of the session check
   *  (`verifySession`, `gates/session.ts`). Optional is load-bearing:
   *  absent in production, so the bypass fails closed there. */
  DEV_ADMIN?: string;

  /** ADR §B.5: rate-limiting binding gating `collect`/`lite`. A
   *  `namespace_id` is self-chosen, not dashboard-provisioned. */
  RATE_LIMITER: RateLimit;
}
