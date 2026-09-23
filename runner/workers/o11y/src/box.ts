// The Loki + Grafana box (ADR-0041 §A). Owned by T01 (COMMON.md shared-file
// table: "workers/o11y/src/box.ts | T01"); this is a do-nothing stub so the
// scaffold deploys in dry-run (T00 scope: no container, no route logic).
//
// `@cloudflare/containers`' `Container` base class, per the contract, with no
// method bodies. Measured (T00-D7, see the T00 task file's Outcome):
// `wrangler deploy --dry-run` accepts a `Container` subclass with no matching
// `containers` entry in `wrangler.jsonc` — it only bundles
// `@cloudflare/containers`' runtime (the upload jumps from ~2 KiB to
// ~54 KiB) and lists the Durable Object binding same as any other. A real
// `wrangler deploy` almost certainly still needs the `containers` entry
// (image, instance type, `max_instances`) to actually schedule the
// container, which is why it stays out of `wrangler.jsonc` here —
// `containers/o11y/`'s Dockerfile does not exist until T01, and this was not
// deployed for real to confirm.
//
// T01 handoff (T00-D9): give this class real behaviour in place (constructor,
// `containerFetch`, the stop protocol, `InboxWriter.recordWake` at start) and
// add the matching `containers` entry to `wrangler.jsonc` in the same change.
// Nothing else needs to move — `env.ts` already imports only this class's
// *type*, and `index.ts` already re-exports the value from here.

import { Container } from "@cloudflare/containers";
import type { Env } from "./env.js";

export class GrafanaBox extends Container<Env> {}
