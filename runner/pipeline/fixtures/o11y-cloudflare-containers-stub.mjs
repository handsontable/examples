// Structural stand-in for `@cloudflare/containers` (only exists inside
// workerd), used by `o11y-worker-hooks.mjs`. `GrafanaBox` (box.ts, T01's
// file) extends `Container<Env>` — no route spec under test constructs one
// (it is only re-exported from `index.ts`), so an inert class is enough.

export class Container {}
