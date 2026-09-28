// The one InboxWriter accessor. `.jurisdiction("eu")` and the plain
// namespace mint different ids for the same name, so every caller must use
// this rather than repeating the two-call chain. `InboxWriter`'s one
// instance is EU-pinned (ADR §H).

import type { Env } from "../env.js";

// No explicit `DurableObjectStub<InboxWriter>` return-type annotation:
// spelling it out sends `tsc` into `TS2589` through the `Env` ↔
// `DurableObjectNamespace<InboxWriter>` ↔ `InboxWriter` type-only cycle;
// plain inference avoids the eager expansion. Locally, workerd throws
// `Jurisdiction restrictions are not implemented`, so `O11Y_ENV ===
// "local"` skips it; production always calls `.jurisdiction("eu")`.
export function inboxWriter(env: Env) {
  const ns = env.O11Y_ENV === "local" ? env.INBOX_WRITER : env.INBOX_WRITER.jurisdiction("eu");
  return ns.get(ns.idFromName("main"));
}
