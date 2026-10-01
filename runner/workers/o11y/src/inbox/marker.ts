// The clean-shutdown marker check (`state/wakes/<wakeId>/clean`). In
// production it is an R2 binding `head`; under `wrangler dev` that binding is
// miniflare's own R2 sim, not the MinIO the box writes to, so local mode asks
// MinIO directly with a SigV4-signed path-style HEAD.

import type { Env } from "../env.js";

const CLEAN_MARKER_PREFIX = "state/wakes/";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

export interface SigV4Input {
  method: string;
  url: URL;
  /** Every header to sign, including `host` and `x-amz-date`. */
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
}

/** The `Authorization` header value for a body-less request. */
export async function signV4(i: SigV4Input): Promise<string> {
  const names = Object.keys(i.headers).map((n) => n.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(i.headers).map(([n, v]) => [n.toLowerCase(), v.trim()]));
  const signedHeaders = names.join(";");
  const canonical = [
    i.method,
    i.url.pathname,
    [...i.url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    signedHeaders,
    EMPTY_SHA256,
  ].join("\n");
  const day = i.amzDate.slice(0, 8);
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)))].join("\n");
  let key = await hmac(`AWS4${i.secretAccessKey}`, day);
  for (const part of [i.region, i.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function localMarkerExists(env: Env, objectKey: string): Promise<boolean> {
  const host = `localhost:${env.O11Y_LOCAL_MINIO_PORT || "4402"}`;
  const url = new URL(`http://${host}/${env.LOKI_S3_BUCKET || "loki"}/${objectKey}`);
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const headers = { host, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": amzDate };
  const authorization = await signV4({
    method: "HEAD",
    url,
    headers,
    accessKeyId: env.LOKI_S3_ACCESS_KEY_ID || "minioadmin",
    secretAccessKey: env.LOKI_S3_SECRET_ACCESS_KEY || "minioadmin",
    region: "auto",
    service: "s3",
    amzDate,
  });
  const res = await fetch(url, { method: "HEAD", headers: { ...headers, authorization } });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  // Unknown is not "clean": the caller's rejection resolves the wake unclean.
  throw new Error(`local marker HEAD ${objectKey}: unexpected status ${res.status}`);
}

/** Whether the box finished a clean shutdown for `wakeId`. */
export async function markerExists(env: Env, wakeId: string): Promise<boolean> {
  const objectKey = `${CLEAN_MARKER_PREFIX}${wakeId}/clean`;
  if (env.O11Y_ENV === "local") return localMarkerExists(env, objectKey);
  return (await env.O11Y_LOKI_STATE.head(objectKey)) !== null;
}
