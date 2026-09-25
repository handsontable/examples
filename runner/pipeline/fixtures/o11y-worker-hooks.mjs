// Module hooks that make the real o11y worker (workers/o11y/src/index.ts,
// and everything it re-exports: `InboxWriter` from inbox/writer.ts, T02;
// `GrafanaBox` from box.ts, T01) loadable under plain
// `node --experimental-strip-types --test` — the same pattern
// `worker-hooks.mjs` uses for `workers/api/src/index.ts` (`mcp-routes.test.mjs`),
// registered via `module.register()` before the worker is imported.
// `node --test` runs each spec file in its own process, so nothing here
// leaks into another pipeline spec. One shared file, not two — T01's and
// T02's specs both import through `index.ts`, so a route spec that only
// exercises T02's ingest routes still needs `GrafanaBox`'s stub resolvable
// (it is re-exported even when never constructed), and a container-lifecycle
// spec that only exercises T01's `box.ts` still needs the `.js`→`.ts` remap.
//
// Three obstacles, three stubs:
//
// - The worker's modules import each other by `.js` specifier (the shape the
//   Workers bundler resolves), but the files on disk are `.ts` — map the
//   extension, only for relative imports inside `workers/o11y/src/`.
//
// - `cloudflare:workers` (the `DurableObject` base class `InboxWriter`
//   extends) only exists inside workerd. `InboxWriter`'s real logic never
//   touches anything the base class provides beyond `this.ctx`/`this.env`
//   (both are stored, nothing else), so an inert stub
//   (`o11y-cloudflare-workers-stub.mjs`) is enough.
//
// - `@cloudflare/containers` (`Container`, `GrafanaBox` extends it) also
//   only exists inside workerd, and imports `cloudflare:workers` itself at
//   load time. Unlike `InboxWriter`, T01's `GrafanaBox` container-lifecycle
//   specs construct and drive a real `GrafanaBox` (start/stop/containerFetch),
//   so its stub (`cloudflare-containers-stub.mjs`) is a fuller structural
//   double, not an inert class — see that file's own header.

const CLOUDFLARE_WORKERS_STUB = new URL("./o11y-cloudflare-workers-stub.mjs", import.meta.url).href;
const CLOUDFLARE_CONTAINERS_STUB = new URL("./cloudflare-containers-stub.mjs", import.meta.url).href;

// `jose`, `source-map-js` (T03 addition — `drain/symbolicate.ts`'s own
// dependency, borrowed the same way for `pipeline/o11y-symbolicate.test.mjs`,
// which needs to build a real source map with `SourceMapGenerator` to test
// against) and `@handsontable/demo-runtime` (any subpath) are
// `workers/o11y`'s dependencies, not the pipeline's — a plain node resolve
// only succeeds when the *importing* file lives under `workers/o11y/`, which
// every gate/normalise module does. A test file under `pipeline/` that also
// wants to sign a test JWT, build a source map, or read
// `decodeNdjson`/`toAePoint` directly to assert on inbox output, has no such
// ancestor `node_modules` entry; borrow one by resolving as if the request
// came from inside `workers/o11y/src/` instead.
const WORKERS_O11Y_SRC_URL = new URL("../../workers/o11y/src/index.ts", import.meta.url).href;
const BORROWED_SPECIFIERS = ["jose", "source-map-js", "@handsontable/demo-runtime"];

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
