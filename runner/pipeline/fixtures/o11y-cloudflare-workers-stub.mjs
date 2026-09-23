// Structural stand-in for `cloudflare:workers` (only exists inside
// workerd), used by `o11y-worker-hooks.mjs`. `InboxWriter` (writer.ts)
// extends `DurableObject<Env>` and reads only `this.ctx`/`this.env` — the
// real base class's constructor signature is `(ctx, env)`, mirrored exactly.

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
