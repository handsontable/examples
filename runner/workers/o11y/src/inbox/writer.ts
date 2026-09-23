// `InboxWriter` — the one owner of the inbox lifecycle (ADR §B.2). Owned by
// T02 (COMMON.md shared-file table: "workers/o11y/src/inbox/** | T02
// (writer.ts, pack.ts, dedupe.ts, registry.ts)"); this is a do-nothing stub so
// the scaffold deploys in dry-run (T00 scope: no ingest, no ledger).
//
// Implements `InboxWriterApi` (COMMON.md interface 1, declared in
// `../env.ts`) — the type both `GrafanaBox` (T01) and every later caller code
// against. `DurableObjectNamespace<T>` requires `T` to extend the ambient
// `Rpc.DurableObjectBranded` type, which only a real `DurableObject` subclass
// satisfies (a bare `InboxWriterApi` interface does not) — so `env.ts` types
// `INBOX_WRITER` over this class, not the interface directly. Every method
// throws so a test against the stub fails loudly instead of resolving
// silently.
//
// T02 handoff (T00-D9): give `recordWake` (and every further method — ingest,
// ledger, dedupe, alert state) real behaviour in place, and add `pack.ts`,
// `dedupe.ts`, `registry.ts` alongside. Nothing else needs to move — `env.ts`
// already imports only this class's *type*, and `index.ts` already
// re-exports the value from here.

import { DurableObject } from "cloudflare:workers";
import type { Env, InboxWriterApi } from "../env.js";

export class InboxWriter extends DurableObject<Env> implements InboxWriterApi {
  async recordWake(_wakeId: string, _reason: "backlog" | "visit"): Promise<void> {
    throw new Error("InboxWriter.recordWake: not implemented (T02 scaffold stub)");
  }
}
