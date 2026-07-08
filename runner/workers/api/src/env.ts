import type { DurableObjectNamespace, D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  // Tier-2 container sessions (Cloudflare Sandbox SDK). Left unparameterized to
  // avoid deep instantiation of the SDK's recursive RPC type (TS2589).
  Sandbox: DurableObjectNamespace;
  // Sharing storage.
  DB: D1Database;
  CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;
  // Public, non-secret config.
  LOGIN_BROKER_URL: string;
  EMBED_ALLOWED_ANCESTORS: string;
}
