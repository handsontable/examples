// Bindings, vars and secrets (observability contract §2). Every name here is the
// contract — a typo becomes every later task's typo (task "Traps").
//
// `InboxWriterApi` is COMMON.md's pinned cross-task interface 1: T02 implements
// the real `InboxWriter` Durable Object (`workers/o11y/src/inbox/writer.ts`),
// `GrafanaBox` (T01) calls `recordWake` at container start, and everything else
// here is a do-nothing stub so the scaffold deploys in dry-run.

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { DurableObject } from "cloudflare:workers";
import { Container } from "@cloudflare/containers";

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

/**
 * Do-nothing stub so `INBOX_WRITER`'s Durable Object namespace type-checks and
 * the scaffold deploys in dry-run. `DurableObjectNamespace<T>` requires `T` to
 * extend the ambient `Rpc.DurableObjectBranded` type, which only a real
 * `DurableObject` subclass satisfies (a bare `InboxWriterApi` interface does
 * not) — so the namespace below is typed over this class, not the interface
 * directly, and `InboxWriterApi` is what callers (T01, T02) code the shape
 * against. T02 replaces this class; every method throws so a test against the
 * stub fails loudly instead of resolving silently.
 */
export class InboxWriter extends DurableObject<Env> implements InboxWriterApi {
  async recordWake(_wakeId: string, _reason: "backlog" | "visit"): Promise<void> {
    throw new Error("InboxWriter.recordWake: not implemented (T02 scaffold stub)");
  }
}

/**
 * Do-nothing stub for the Loki + Grafana box (T01): `@cloudflare/containers`'
 * `Container` base class, per the contract, with no method bodies. Measured
 * (T00-D7, see the task Outcome): `wrangler deploy --dry-run` accepts a
 * `Container` subclass with no matching `containers` entry in
 * `wrangler.jsonc` — it only bundles `@cloudflare/containers`' runtime (the
 * upload jumps from ~2 KiB to ~54 KiB) and lists the Durable Object binding
 * same as any other. A real `wrangler deploy` almost certainly still needs
 * the `containers` entry (image, instance type, `max_instances`) to actually
 * schedule the container, which is why it stays out of `wrangler.jsonc` here
 * — `containers/o11y/`'s Dockerfile does not exist until T01, and this was
 * not deployed for real to confirm. T01 adds that entry in the same change
 * that gives this class real behaviour.
 */
export class GrafanaBox extends Container<Env> {}

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

  O11Y_EXPORT_SECRET: string;
  SENTRY_HOOK_SECRET: string;
  AE_SQL_TOKEN: string;
  LOKI_S3_ACCESS_KEY_ID: string;
  LOKI_S3_SECRET_ACCESS_KEY: string;
  SLACK_WEBHOOK_URL: string;

  /** `.dev.vars` only — fail-closed local bypass of the Access check
   *  (`verifyAccess`, T02, `workers/o11y/src/gates/access.ts`). Optional is
   *  load-bearing: absent in production, so the bypass fails closed there. */
  DEV_ADMIN?: string;
}
