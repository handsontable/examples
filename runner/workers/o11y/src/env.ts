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
import type { GrafanaBox } from "./box.js";
import type { InboxWriter } from "./inbox/writer.js";

/**
 * `InboxWriter`'s RPC surface, pinned by the controller (COMMON.md interface 1).
 * Further methods (ingest, ledger/backlog, alert state) are added by T02–T04 on
 * this same interface — never a second one.
 */
export interface InboxWriterApi {
  /** Writes contract §8 `wake:<wakeId> = { startedAt, reason, over: false }` and
   *  marks every earlier wake `over: true`. Called by `GrafanaBox` (T01) at
   *  container start. */
  recordWake(wakeId: string, reason: "backlog" | "visit"): Promise<void>;
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
  /** T01-D (phase 2, minimal touch per COMMON.md — recorded in the T01
   *  Outcome, contract doc untouched): duplicates wrangler.jsonc's top-level
   *  `account_id`. Workers do not get their own account id at runtime, and
   *  `GrafanaBox` needs it to build the Loki bucket's R2 S3 endpoint
   *  (`https://<account-id>.eu.r2.cloudflarestorage.com`, ADR-0041 §A) and
   *  the Analytics Engine SQL API URL for the ClickHouse datasource
   *  (`https://api.cloudflare.com/client/v4/accounts/<account-id>/analytics_engine/sql`). */
  CLOUDFLARE_ACCOUNT_ID: string;

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
}
