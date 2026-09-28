// Structural stand-in for `cloudflare:workers` (only exists inside
// workerd), used by `o11y-worker-hooks.mjs` and `worker-hooks.mjs`.
// `InboxWriter` (writer.ts) extends `DurableObject<Env>` and reads only
// `this.ctx`/`this.env` — the real base class's constructor signature is
// `(ctx, env)`, mirrored exactly. `WorkerEntrypoint` covers
// `workers/o11y/src/heartbeat.ts` (`O11yHeartbeat`) and
// `workers/api/src/o11y-usage.ts` (`O11yUsage`) the same way, since both
// read only `this.ctx`/`this.env` too. Shared across both hook files
// rather than a second stub.

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
