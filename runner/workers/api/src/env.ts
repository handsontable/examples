import type {
  AnalyticsEngineDataset,
  DurableObjectNamespace,
  D1Database,
  Fetcher,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";

// Tier-2 container sessions. `Sandbox` is the single live-preview namespace
// required by proxyToSandbox; `SANDBOX_BUILDER` runs the share snapshotter.
// Namespaces are unparameterized to avoid deep instantiation of the Sandbox
// SDK's recursive RPC type (TS2589).
export interface Env {
  Sandbox: DurableObjectNamespace;
  SANDBOX_BUILDER: DurableObjectNamespace;
  /** Detached snapshot builds for the MCP service path (snapshot-jobs.ts): a
   *  plain sqlite DO — no container — whose alarm runs a tier-2 build after the
   *  route has already answered. One object per demo id. */
  BUILD_JOBS: DurableObjectNamespace;

  // Sharing storage.
  DB: D1Database;
  CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;

  /** Shared secret for the MCP service path (`wrangler secret put MCP_SHARED_SECRET`).
   *  Absent -> `POST /api/mcp/demos` 401s for everyone, which is the safe default
   *  (DEV-2501, ADR-0033). Never in git. */
  MCP_SHARED_SECRET?: string;

  // Public, non-secret config.
  LOGIN_BROKER_URL: string;
  EMBED_ALLOWED_ANCESTORS: string;
  // Sentry ingest endpoint (write-only, committed in wrangler.jsonc `vars`).
  // NOT named SENTRY_DSN on purpose — the SDK auto-reads that exact key from env
  // and would bypass the local-dev gate in sentry-gate.ts. See the note there.
  ERROR_REPORTING_DSN: string;
  // The Sentry `environment`, and the second half of the reporting gate (DEV-2540).
  // Supplied ONLY by the `deploy` script's `--var SENTRY_ENVIRONMENT:api-production`
  // — never in the wrangler.jsonc `vars` block and never in `.dev.vars`. Its absence
  // is what keeps `wrangler dev` silent even though `PREVIEW_HOST` still carries the
  // committed production value. See src/sentry-gate.ts.
  // Optional is load-bearing: a required field breaks `wrangler dev` typechecking.
  SENTRY_ENVIRONMENT?: string;
  // Cloudflare-managed per-deploy version id, used as the Sentry release.
  CF_VERSION_METADATA: { id: string; tag: string };
  // Wildcard base host for Tier-2 container preview URLs (e.g.
  // "demos.handsontable.com"). Empty -> use the request host (local dev).
  PREVIEW_HOST?: string;
  // "1" injects the demo-runtime monitor into proxied Tier-2 preview documents
  // (DEV-2527). Temporary; the browser half is VITE_MONITOR_DEMOS. Paired with the
  // PREVIEW_HOST production check, so `wrangler dev` never injects.
  MONITOR_DEMOS?: string;

  // Cost guardrails (DEV-2030). All optional with safe defaults in budget.ts,
  // so a missing var can never be the reason a session is refused.
  /** Self-enforced monthly ceiling in USD. Cloudflare has no hard spend cap. */
  BUDGET_MONTHLY_USD?: string;
  /** Fractions of the ceiling at which each degradation tier starts. */
  BUDGET_WARN_PCT?: string;
  BUDGET_ANON_BLOCK_PCT?: string;
  BUDGET_NEW_BLOCK_PCT?: string;
  BUDGET_CLOSED_PCT?: string;
  /** "1" enforces the tiers; anything else observes and logs only. */
  BUDGET_ENFORCE?: string;
  /** Comma-separated dollar figures for the in-app spend alerts. */
  BUDGET_ALERTS_USD?: string;
  /** ADR-0041 §G default for `settings.ts#o11yBudgetUsd` ($15/month) — the
   *  o11y stack's own spend ceiling, separate from `BUDGET_MONTHLY_USD`. */
  O11Y_BUDGET_USD?: string;
  /** Days of anonymous audience data to keep (visitor hashes). */
  ANALYTICS_RETENTION_DAYS?: string;
  /** Days after revocation before a demo's R2 artifacts are purged. 0 = off. */
  BUDGET_R2_GC_DAYS?: string;
  /** Account tag for the GraphQL Analytics API (same id as wrangler.jsonc).
   *  Reused, alongside `AE_SQL_TOKEN` below, by `reconcile.ts`'s production
   *  Analytics Engine SQL API read for the nightly `example_daily` rollup
   *  (C-I1). */
  CF_ACCOUNT_ID?: string;
  /** This Worker's script name + its R2 bucket. The nightly reconciliation
   *  scopes every analytics query to them, so a shared account's other
   *  Workers can never be counted as this runner's spend. */
  CF_SCRIPT_NAME?: string;
  R2_BUCKET_NAME?: string;
  /** Read-only analytics token (`wrangler secret put CF_ANALYTICS_TOKEN`).
   *  Absent -> the nightly reconciliation is skipped, estimates stand. */
  CF_ANALYTICS_TOKEN?: string;

  // Example chat (DEV-2047). See src/chat.ts and docs/example-chat.md.
  /** LiteLLM gateway base URL (no trailing slash needed). */
  LITELLM_API_BASE?: string;
  /** Model id as configured on the gateway. */
  LITELLM_MODEL?: string;
  /** Virtual key for the gateway (`wrangler secret put LITELLM_API_KEY`).
   *  Absent -> /api/chat answers 503; nothing else is affected. */
  LITELLM_API_KEY?: string;
  /** Algolia DocSearch credentials for the docs page lookup. The app id and
   *  index are public config; the search key is a secret only by convention. */
  ALGOLIA_APP_ID?: string;
  ALGOLIA_INDEX?: string;
  ALGOLIA_API_KEY?: string;

  // ---- Observability (ADR-0041). RUNNER_EVENTS/O11Y/SENTRY_SCOPE were T00
  // scaffold-only additions; this worker (src/telemetry/**) now wires real
  // usage against them (T05).
  /** Analytics Engine dataset `runner_events` (contract §4), the same binding
   *  name and dataset the o11y worker writes to. */
  RUNNER_EVENTS?: AnalyticsEngineDataset;
  /** Service binding to `handsontable-demos-o11y` — `heartbeat()` for the
   *  watchdog cron (ADR §F.3), later `AdminReads` (ADR-0043). Read by T04's
   *  watchdog, dispatched from the 5-minute cron branch in `scheduled()`. */
  O11Y?: Fetcher;
  /** `full` (default) | `uncaught` (contract §11) — which handled-error
   *  reports also go to Sentry. Absent means `full`, exactly like leaving the
   *  var out of `wrangler.jsonc` does today. See `telemetry/diagnostic.ts`. */
  SENTRY_SCOPE?: "full" | "uncaught";
  /** `service.version` (contract §2/§D): the full deploy `GITHUB_SHA`, set
   *  only by the `deploy` script's `--var SERVICE_VERSION:$GITHUB_SHA`
   *  (`package.json`) — absent under `wrangler dev` and a bare `wrangler
   *  deploy`. See `telemetry/resource.ts#serviceVersion` for the fallback. */
  SERVICE_VERSION?: string;
  /** Local-mode `RUNNER_EVENTS` stand-in (contract §10): ClickHouse HTTP
   *  endpoint, `.dev.vars` only, never in the committed `wrangler.jsonc` vars
   *  block. Defaults to `http://localhost:8123` when absent. Not a
   *  contract-pinned var name of its own — reuses `AE_SQL_TOKEN`'s
   *  credential shape below for this worker's own local writes. See
   *  `telemetry/resource.ts`. */
  RUNNER_EVENTS_CLICKHOUSE_URL?: string;
  /** Local mode: ClickHouse HTTP password for the sink above (`.dev.vars`
   *  only). Production: the Analytics Engine SQL API token, a real Worker
   *  secret (`wrangler secret put AE_SQL_TOKEN`, run-and-deploy.md step 6b) —
   *  now a contract §2 API-worker row (C-I1). Read by
   *  `reconcile.ts#queryExampleEventTotals` for the nightly `example_daily`
   *  rollup (ADR-0042 §5); absent in production means that read throws
   *  rather than silently returning zero rows and deleting the day. */
  AE_SQL_TOKEN?: string;

  // Index signature so we can look up a binding by generated name.
  [key: string]: unknown;
}
