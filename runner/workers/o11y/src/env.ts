// Bindings, vars and secrets (observability contract §2). Every name here is the
// contract — a typo becomes every later task's typo (task "Traps").
//
// `InboxWriterApi` is COMMON.md's pinned cross-task interface 1: T02 implements
// the real `InboxWriter` Durable Object (`workers/o11y/src/inbox/writer.ts`),
// `GrafanaBox` (T01, `workers/o11y/src/box.ts`) calls `recordWake` at container
// start. Both classes live in the files the shared-file table gives their
// owners (T00-D9, see the task Outcome) — this file only declares the
// interface and the `Env` shape, importing the class *types* (never their
// values) from those files for the `DurableObjectNamespace<T>` parameters, so
// there is no runtime import cycle even though the types reference each other.

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { AlertState, Heartbeat, NormalisedRecord, Tenant } from "@handsontable/demo-runtime/telemetry";
import type { GrafanaBox } from "./box.js";
import type { InboxWriter } from "./inbox/writer.js";

/**
 * T02 addition to the pinned interface (COMMON.md interface 1 explicitly
 * allows T02 to add ingest methods here): one item the route handler hands to
 * `InboxWriter.ingest` after ADR §B.2 steps 1–3 (decode/scrub, hash, stamp).
 * `hash` is computed over the pre-stamp record (T02-D1, see this task's
 * Outcome) so a redelivered body hashes identically regardless of arrival
 * time. `fingerprint` is set only for exception/error records whose surface
 * feeds the new-fingerprint alert (`feedsNewFingerprintAlert`, §7) — absent
 * otherwise, so `InboxWriter` never has to re-derive that decision.
 */
export interface IngestItem {
  hash: string;
  record: NormalisedRecord;
  fingerprint?: string;
}

export type IngestOutcome = "accepted" | "duplicate";

export interface IngestItemResult {
  hash: string;
  outcome: IngestOutcome;
}

export interface IngestResult {
  results: IngestItemResult[];
}

/**
 * `InboxWriter`'s RPC surface, pinned by the controller (COMMON.md interface 1).
 * Further methods (ledger/backlog, alert state) are added by T03/T04 on this
 * same interface — never a second one.
 */
export interface InboxWriterApi {
  /** Writes contract §8 `wake:<wakeId> = { startedAt, reason, over: false }` and
   *  marks every earlier wake `over: true`. Called by `GrafanaBox` (T01) at
   *  container start. */
  recordWake(wakeId: string, reason: "backlog" | "visit"): Promise<void>;

  /**
   * ADR §B.2 steps 4–5, T02: dedupe each item's `hash` against the 24 h window
   * (`hash:<sha256>`), append every non-duplicate record to storage rows ≤ 1 MB
   * (arrival time on the row, never in the record), update the exact
   * fingerprint first-seen registry (`fp:<fingerprint>`) and the
   * `heartbeat.lastIngest` marker, and answer only after the transaction
   * commits. Returns the per-item outcome so the route handler can write
   * aggregated `o11y.ingest` `accepted`/`duplicate` points (one point per
   * request, per T02-D — see the task Outcome for why per-record points would
   * violate exit criterion 4's "one duplicate point").
   */
  ingest(tenant: Tenant, arrivalMs: number, items: IngestItem[]): Promise<IngestResult>;

  // ---- T04 additions (alerts, watchdog, the o11y spend cap) --------------
  //
  // Contract §8's `alert:<rule>`, `drainsPaused` and `heartbeat` storage
  // keys are all read/written exclusively through these methods — nothing
  // outside `InboxWriter` ever touches DO storage directly (same rule as
  // `ingest`/`recordWake`). `heartbeat()` here is `InboxWriter`'s own
  // storage read, composed by `heartbeat.ts`'s `O11yHeartbeat`
  // `WorkerEntrypoint` (this task's "Owns" row) into the full watchdog
  // report alongside `backlogOldestAgeMs()`.

  /** `heartbeat` (§8): `lastIngest` is stamped by `ingest()` already;
   *  `lastCron` is stamped by whichever cron currently calls
   *  `stampCronHeartbeat` — today this task's own placeholder `scheduled()`
   *  (COMMON.md's "wire it minimally" note), T03's real ten-minute backlog
   *  cron after the merge. */
  heartbeat(): Promise<Heartbeat>;
  /** Sets `heartbeat.lastCron` to `nowMs`, preserving `lastIngest`. Exists
   *  only so a cron tick (this task's placeholder, later T03's real one)
   *  can prove liveness the same way `ingest()` already proves it for
   *  `lastIngest` — never called from an ingest route. */
  stampCronHeartbeat(nowMs: number): Promise<void>;

  /** Oldest still-`written` (not yet drained) inbox key's age, in ms, or
   *  `null` when the backlog is empty. Derived from the key's own embedded
   *  `<yyyy-mm-dd>/<hh>` (contract §8's inbox key shape), taken as
   *  `<hour>:59:59.999` UTC — a lower bound on the true age (T04-D, see the
   *  task Outcome), so the backlog-age alert can only fire late, never
   *  early. A `provisional:<wakeId>`/`committed`/`rejected:<reason>` key is
   *  not backlog — only bare `written` counts (ADR §B.3: "`backlog()`
   *  counts only `written` keys"). */
  backlogOldestAgeMs(): Promise<number | null>;
  /** Count of `key:<k> = rejected:<reason>` entries — ADR §F.3's "a
   *  `rejected` inbox key" rule reads this, not the raw storage. */
  rejectedKeyCount(): Promise<number>;

  /** `fp:<fingerprint>` entries first seen strictly after `sinceMs` —
   *  `demo-runtime` fingerprints are already excluded (they never reach the
   *  registry at all: `feedsNewFingerprintAlert`, contract §7), so every
   *  name returned here is alert-eligible by construction. */
  newFingerprintsSince(sinceMs: number): Promise<string[]>;

  /** `alert:<rule>` (§8): the exact fire-once/resolve-once state the ADR
   *  §F.3 rule evaluator reads and writes every tick. */
  alertState(rule: string): Promise<AlertState | undefined>;
  setAlertState(rule: string, state: AlertState): Promise<void>;

  /** Small scalar bookkeeping a rule needs beyond `firing`/`resolved` (a
   *  last-seen count, a cursor) — not itself part of the contract's fixed
   *  `alert:<rule>` shape, so it lives under its own `alertMeta:<key>`
   *  prefix rather than overloading `AlertState`. */
  getAlertMeta(key: string): Promise<string | undefined>;
  setAlertMeta(key: string, value: string): Promise<void>;

  /** `drainsPaused` (§8, ADR §G): set when the o11y spend cap is crossed,
   *  cleared on resolve (month rollover or a raised cap). T03's wake path
   *  reads this to refuse a *backlog* wake while paused; a Grafana visit
   *  wake is unaffected by design (ADR §G: "visit wakes still work"). */
  drainsPaused(): Promise<boolean>;
  setDrainsPaused(paused: boolean): Promise<void>;
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
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  GITHUB_OIDC_REPOSITORY: string;
  /** T02-D16 addition (fix round, see the task Outcome): ADR §B.5's `deploy`
   *  row names "issuer, audience, repository, **workflow**" — the workflow
   *  claim was missing from the first pass. GitHub's OIDC `workflow_ref`
   *  claim, exact match, `<owner>/<repo>/<workflow file path>@<ref>`. T10
   *  must keep this in sync with the real deploy workflow's path/ref if it
   *  ever moves. */
  GITHUB_OIDC_WORKFLOW_REF: string;

  /** T02 addition to `wrangler.jsonc`'s `vars` (see the task Outcome): the
   *  `o11y.ingest` self-metric (`normalise/respond.ts`) needs the o11y
   *  worker's own `service.version`, the same way the API worker's deploy
   *  script sets `SERVICE_VERSION` (contract §2). Optional — `wrangler dev`
   *  sets no such var, so every reader falls back to `"dev"`. */
  SERVICE_VERSION?: string;

  /** T01-D (phase 2, minimal touch per COMMON.md — recorded in the T01
   *  Outcome, contract doc untouched): duplicates wrangler.jsonc's top-level
   *  `account_id`. Workers do not get their own account id at runtime, and
   *  `GrafanaBox` needs it to build the Loki bucket's R2 S3 endpoint
   *  (`https://<account-id>.eu.r2.cloudflarestorage.com`, ADR-0041 §A) and
   *  the Analytics Engine SQL API URL for the ClickHouse datasource
   *  (`https://api.cloudflare.com/client/v4/accounts/<account-id>/analytics_engine/sql`). */
  CLOUDFLARE_ACCOUNT_ID: string;
  /** T01-D (phase 2 fix round, I4): the Loki bucket name `GrafanaBox` tells
   *  the container to write to. Optional, not a var with a required
   *  presence check — box.ts falls back to the production bucket name
   *  when this is unset, so `wrangler.jsonc` need not set it at all. Exists
   *  so a throwaway sandbox-probe config (never committed, COMMON.md probe
   *  rules) can point a probe `GrafanaBox` at its own bucket
   *  (e.g. `o11y-probe-t03-loki`) instead of silently targeting production. */
  LOKI_S3_BUCKET?: string;

  /** T04 addition (local-mode alert queries, contract §10): local-mode
   *  stand-in for the Analytics Engine SQL API's URL, mirroring
   *  `workers/api/src/env.ts`'s `RUNNER_EVENTS_CLICKHOUSE_URL` (T05-D1, same
   *  reasoning — the contract's §2 table only pins `AE_SQL_TOKEN`, not a
   *  local ClickHouse URL var, for either worker). `.dev.vars` only, never
   *  in the committed `wrangler.jsonc` `vars` block. Defaults to
   *  `http://localhost:8123` when absent — see `alerts/ae-query.ts`. */
  RUNNER_EVENTS_CLICKHOUSE_URL?: string;

  // Secrets: optional, matching workers/api/src/env.ts's MCP_SHARED_SECRET
  // style — a required field would force wrangler dev to typecheck against a
  // secret that only exists in .dev.vars, and would let a gate assume
  // presence instead of checking it. Every gate that reads one of these must
  // fail closed when it is absent, the same rule DEV_ADMIN already documents
  // below.
  O11Y_EXPORT_SECRET?: string;
  SENTRY_HOOK_SECRET?: string;
  AE_SQL_TOKEN?: string;
  LOKI_S3_ACCESS_KEY_ID?: string;
  LOKI_S3_SECRET_ACCESS_KEY?: string;
  SLACK_WEBHOOK_URL?: string;

  /** `.dev.vars` only — fail-closed local bypass of the Access check
   *  (`verifyAccess`, T02, `workers/o11y/src/gates/access.ts`). Optional is
   *  load-bearing: absent in production, so the bypass fails closed there. */
  DEV_ADMIN?: string;

  /** ADR §B.5: the Workers rate-limiting binding gating `collect`/`lite`. T00
   *  left this out of `wrangler.jsonc` pending "a real namespace id from the
   *  dashboard" — measured false (T02-D, see the task Outcome): a rate-limit
   *  binding's `namespace_id` is a self-chosen scoping id, not a
   *  dashboard-provisioned resource, confirmed against `wrangler`'s own
   *  config schema and a real `wrangler deploy --dry-run`. Added here. */
  RATE_LIMITER: RateLimit;
}
