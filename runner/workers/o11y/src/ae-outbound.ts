// Outbound handler for GrafanaBox's Analytics Engine SQL calls (ADR-0041 §A).
// The container's own egress to api.cloudflare.com is refused with Cloudflare
// error 1000 (dns_loop), so the container calls this fake host and the Worker
// makes the real request, which also keeps AE_SQL_TOKEN out of the box.

import type { Env } from "./env.js";

/** The fake hostname the container's ClickHouse datasource points at. */
export const AE_INTERNAL_HOST = "ae.internal";

const AE_API_ORIGIN = "https://api.cloudflare.com";
// A ClickHouse SQL statement is a few KB; the cap stops the container using this route as a large-upload relay.
const MAX_BODY_BYTES = 1_000_000;

type AeOutboundEnv = Pick<Env, "CLOUDFLARE_ACCOUNT_ID" | "AE_SQL_TOKEN">;

/** The one path the container may reach, for the configured account. */
export function aeSqlPath(accountId: string): string {
  return `/client/v4/accounts/${accountId}/analytics_engine/sql`;
}

/** Container-side URL for the datasource; plain http, so no CA is needed. */
export function aeInternalUrl(accountId: string): string {
  return `http://${AE_INTERNAL_HOST}${aeSqlPath(accountId)}`;
}

/** Reads `body` up to `limit` bytes; null (after cancelling the stream) as soon as the running total exceeds it. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain" } });
}

export async function handleAeOutbound(
  req: Request,
  env: AeOutboundEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  // One trailing dot names the same host; the SDK's ContainerProxy normalises it before dispatch too.
  if (url.hostname.replace(/\.$/, "") !== AE_INTERNAL_HOST) return refuse(403, "host not allowed");
  if (req.method !== "GET" && req.method !== "POST") return refuse(405, "method not allowed");
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.AE_SQL_TOKEN) return refuse(503, "analytics engine access not configured");

  // Grafana's datasource proxy appends a trailing slash to the datasource URL.
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== aeSqlPath(env.CLOUDFLARE_ACCOUNT_ID)) return refuse(403, "path not allowed");

  let body: Uint8Array | undefined;
  if (req.method === "POST") {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return refuse(413, "body too large");
    const read = await readCapped(req.body, MAX_BODY_BYTES);
    if (!read) return refuse(413, "body too large");
    body = read;
  }

  // Fresh headers: nothing the container sends, least of all Authorization, is forwarded.
  const headers = new Headers({ Authorization: `Bearer ${env.AE_SQL_TOKEN}` });
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const upstream = await fetchImpl(`${AE_API_ORIGIN}${path}${url.search}`, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" },
  });
}
