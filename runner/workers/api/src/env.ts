import type { DurableObjectNamespace, D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";

// Tier-2 container sessions — one Durable Object binding per framework image.
// Namespaces are unparameterized to avoid deep instantiation of the Sandbox
// SDK's recursive RPC type (TS2589).
export interface Env {
  SANDBOX_REMIX: DurableObjectNamespace;
  SANDBOX_ANGULAR: DurableObjectNamespace;
  SANDBOX_NEXT: DurableObjectNamespace;
  SANDBOX_NEXT_SHADCN: DurableObjectNamespace;
  SANDBOX_ASTRO: DurableObjectNamespace;
  SANDBOX_NUXT: DurableObjectNamespace;
  // Generic builder for the share snapshotter (no baked deps).
  SANDBOX_BUILDER: DurableObjectNamespace;

  // Sharing storage.
  DB: D1Database;
  CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;

  // Public, non-secret config.
  LOGIN_BROKER_URL: string;
  EMBED_ALLOWED_ANCESTORS: string;
  // Wildcard base host for Tier-2 container preview URLs (e.g.
  // "demos.handsontable.com"). Empty -> use the request host (local dev).
  PREVIEW_HOST?: string;

  // Index signature so we can look up a binding by generated name.
  [key: string]: unknown;
}
