import type { DurableObjectNamespace, D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";

// Tier-2 container sessions. `Sandbox` is the single live-preview namespace
// required by proxyToSandbox; `SANDBOX_BUILDER` runs the share snapshotter.
// Namespaces are unparameterized to avoid deep instantiation of the Sandbox
// SDK's recursive RPC type (TS2589).
export interface Env {
  Sandbox: DurableObjectNamespace;
  SANDBOX_BUILDER: DurableObjectNamespace;

  // Sharing storage.
  DB: D1Database;
  CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;

  // Public, non-secret config.
  LOGIN_BROKER_URL: string;
  EMBED_ALLOWED_ANCESTORS: string;
  // Sentry ingest endpoint (write-only, committed in wrangler.jsonc `vars`).
  // NOT named SENTRY_DSN on purpose — the SDK auto-reads that exact key from env
  // and would bypass the local-dev gate in index.ts. See the note there.
  ERROR_REPORTING_DSN: string;
  // Cloudflare-managed per-deploy version id, used as the Sentry release.
  CF_VERSION_METADATA: { id: string; tag: string };
  // Wildcard base host for Tier-2 container preview URLs (e.g.
  // "demos.handsontable.com"). Empty -> use the request host (local dev).
  PREVIEW_HOST?: string;

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
  /** Days of anonymous audience data to keep (visitor hashes). */
  ANALYTICS_RETENTION_DAYS?: string;
  /** Days after revocation before a demo's R2 artifacts are purged. 0 = off. */
  BUDGET_R2_GC_DAYS?: string;
  /** Account tag for the GraphQL Analytics API (same id as wrangler.jsonc). */
  CF_ACCOUNT_ID?: string;
  /** This Worker's script name + its R2 bucket. The nightly reconciliation
   *  scopes every analytics query to them, so a shared account's other
   *  Workers can never be counted as this runner's spend. */
  CF_SCRIPT_NAME?: string;
  R2_BUCKET_NAME?: string;
  /** Read-only analytics token (`wrangler secret put CF_ANALYTICS_TOKEN`).
   *  Absent -> the nightly reconciliation is skipped, estimates stand. */
  CF_ANALYTICS_TOKEN?: string;

  // Index signature so we can look up a binding by generated name.
  [key: string]: unknown;
}
