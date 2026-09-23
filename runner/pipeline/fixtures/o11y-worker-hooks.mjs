// Module hooks that make the real o11y router (workers/o11y/src/index.ts)
// loadable under plain `node --experimental-strip-types --test` — the same
// pattern `worker-hooks.mjs` uses for `workers/api/src/index.ts`
// (`mcp-routes.test.mjs`), registered via `module.register()` before the
// worker is imported. `node --test` runs each spec file in its own process,
// so nothing here leaks into another pipeline spec.
//
// Two obstacles, two stubs:
//
// - The worker's modules import each other by `.js` specifier (the shape the
//   Workers bundler resolves), but the files on disk are `.ts` — map the
//   extension, only for relative imports inside `workers/o11y/src/`.
//
// - `cloudflare:workers` (the `DurableObject` base class, `InboxWriter`
//   extends it) and `@cloudflare/containers` (`Container`, `GrafanaBox`
//   extends it, re-exported from `index.ts`) only exist inside workerd. A
//   structural stub stands in for each — `InboxWriter`'s real logic never
//   touches anything the base class provides beyond `this.ctx`/`this.env`
//   (both are stored, nothing else), and no route spec constructs a
//   `GrafanaBox` at all (it is only re-exported, never called), so an inert
//   stub is enough.

const CLOUDFLARE_WORKERS_STUB = new URL("./o11y-cloudflare-workers-stub.mjs", import.meta.url).href;
const CLOUDFLARE_CONTAINERS_STUB = new URL("./o11y-cloudflare-containers-stub.mjs", import.meta.url).href;

// `jose` and `@handsontable/demo-runtime` (any subpath) are `workers/o11y`'s
// dependencies, not the pipeline's — a plain node resolve only succeeds when
// the *importing* file lives under `workers/o11y/`, which every gate/normalise
// module does. A test file under `pipeline/` that also wants to sign a test
// JWT, or read `decodeNdjson`/`toAePoint` directly to assert on inbox
// output, has no such ancestor `node_modules` entry; borrow one by resolving
// as if the request came from inside `workers/o11y/src/` instead.
const WORKERS_O11Y_SRC_URL = new URL("../../workers/o11y/src/index.ts", import.meta.url).href;
const BORROWED_SPECIFIERS = ["jose", "@handsontable/demo-runtime"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: CLOUDFLARE_WORKERS_STUB, shortCircuit: true };
  }
  if (specifier === "@cloudflare/containers") {
    return { url: CLOUDFLARE_CONTAINERS_STUB, shortCircuit: true };
  }
  if (
    BORROWED_SPECIFIERS.some((s) => specifier === s || specifier.startsWith(`${s}/`))
    && !context.parentURL?.includes("/workers/o11y/")
  ) {
    return nextResolve(specifier, { ...context, parentURL: WORKERS_O11Y_SRC_URL });
  }
  if (
    specifier.startsWith(".")
    && specifier.endsWith(".js")
    && context.parentURL?.includes("/workers/o11y/src/")
  ) {
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
  return nextResolve(specifier, context);
}
