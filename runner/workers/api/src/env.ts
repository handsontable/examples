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

  // Index signature so we can look up a binding by generated name.
  [key: string]: unknown;
}
