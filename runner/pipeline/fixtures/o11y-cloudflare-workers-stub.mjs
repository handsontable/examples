// Structural stand-in for `cloudflare:workers` (only exists inside
// workerd), used by `o11y-worker-hooks.mjs` AND (T04) `worker-hooks.mjs`.
// `InboxWriter` (writer.ts) extends `DurableObject<Env>` and reads only
// `this.ctx`/`this.env` — the real base class's constructor signature is
// `(ctx, env)`, mirrored exactly.
//
// T04: `WorkerEntrypoint` added for `workers/o11y/src/heartbeat.ts`
// (`O11yHeartbeat`) and `workers/api/src/o11y-usage.ts` (`O11yUsage`) — both
// read only `this.ctx`/`this.env` too, so the same shape covers it. Shared
// across both hook files rather than a second stub, per COMMON.md's "don't
// keep two diverging copies" spirit.

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
