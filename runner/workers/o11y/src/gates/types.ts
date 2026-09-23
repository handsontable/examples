// One shared result shape for every gate (ADR §B.5), so the route handlers
// can compose them uniformly and the central drop-writer (`respond.ts`) has
// one thing to inspect. `reason` becomes the `o11y.ingest` `blob9` value
// (contract §5: "reason = gate") — keep it a short, stable, machine-grade
// token (`"host"`, `"bot"`, `"size"`, `"kind"`, `"rate_limit"`, `"secret"`,
// `"oidc"`, `"hmac"`, `"access"`), never a sentence.

export interface GateOk {
  ok: true;
}

export interface GateDrop {
  ok: false;
  /** The `o11y.ingest` `reason` (§5) — the gate name. */
  reason: string;
  /** The HTTP status the route answers with when this gate rejects. */
  status: number;
  /** Optional human-readable detail, logged but never sent to the client (the
   *  ingest routes are public and unauthenticated up to this point — no gate
   *  reason should leak *why* a secret/HMAC/OIDC check failed). */
  detail?: string;
}

export type GateResult = GateOk | GateDrop;

export function ok(): GateOk {
  return { ok: true };
}

export function drop(reason: string, status: number, detail?: string): GateDrop {
  return { ok: false, reason, status, detail };
}
