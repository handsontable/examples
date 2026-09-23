// One DO accessor (T02-D, see the task Outcome): `.jurisdiction("eu")` and
// the ordinary namespace address different objects — `env.INBOX_WRITER
// .idFromName("main")` (no jurisdiction call) and
// `env.INBOX_WRITER.jurisdiction("eu").idFromName("main")` mint different
// ids, so a caller that used the first while this route handler used the
// second would silently talk to two different Durable Objects with no
// error. `InboxWriter`'s one instance is EU-pinned (ADR §H) — every caller
// (this task's own routes, T01's `GrafanaBox.recordWake` call, T03's
// ledger/backlog, T04's alert cron) must go through this one function
// instead of repeating the two-call chain.

import type { Env } from "../env.js";

// No explicit `DurableObjectStub<InboxWriter>` return-type annotation here on
// purpose: spelling it out sends `tsc` into `TS2589: Type instantiation is
// excessively deep and possibly infinite` — `InboxWriter`'s real `ingest`
// method now carries `IngestItem[]`/`NormalisedRecord` parameter types that,
// combined with the `Env` ↔ `DurableObjectNamespace<InboxWriter>` ↔
// `InboxWriter` ↔ `Env` type-only cycle T00-D9 already documented as
// load-bearing (the stub-era cycle was cheap enough not to trip this;
// real method signatures push it over the recursion limit when the RPC stub
// type is force-expanded by an explicit annotation). Plain inference through
// `.jurisdiction("eu").get(...)` resolves the same type without the eager
// expansion — verified with a clean `tsc --noEmit` (see the task Outcome).
// T02-D — `.jurisdiction("eu")` is skipped under `O11Y_ENV === "local"` (see
// the task Outcome, discovered running a real `wrangler dev`, not by reading
// docs): Miniflare/workerd's local Durable Object simulation throws
// `Error: Jurisdiction restrictions are not implemented in workerd` the
// moment `.jurisdiction()` is called at all — not a silent no-op, an actual
// exception on every request, which made every route 500 under
// `wrangler dev` until this fix. This is exactly the task file's own
// documented trap ("Jurisdiction is not enforced locally; a green local run
// is not evidence of EU placement") — restated here as "not *callable*
// locally," which is stronger than "not enforced." Production
// (`O11Y_ENV === "production"`) always calls `.jurisdiction("eu")`,
// unchanged.
export function inboxWriter(env: Env) {
  const ns = env.O11Y_ENV === "local" ? env.INBOX_WRITER : env.INBOX_WRITER.jurisdiction("eu");
  return ns.get(ns.idFromName("main"));
}
