// Module hooks that make the real o11y worker (workers/o11y/src/index.ts,
// re-exporting `InboxWriter` and `GrafanaBox`) loadable under plain
// `node --experimental-strip-types --test`, registered via
// `module.register()` before the worker is imported. One shared file, not
// two, since both specs import through `index.ts`.
//
// Three obstacles: the worker's modules import each other by `.js`
// specifier (the Workers bundler's shape) but the files on disk are `.ts`
// — map the extension for relative imports inside `workers/o11y/src/`.
// `cloudflare:workers` (`InboxWriter`'s DurableObject base) only exists
// inside workerd, and needs only an inert stub
// (`o11y-cloudflare-workers-stub.mjs`) since `InboxWriter` touches nothing
// beyond `this.ctx`/`this.env`. `@cloudflare/containers` (`GrafanaBox`'s
// base) also only exists inside workerd; `GrafanaBox`'s own
// container-lifecycle specs drive a real instance, so its stub
// (`cloudflare-containers-stub.mjs`) is a fuller structural double.

const CLOUDFLARE_WORKERS_STUB = new URL("./o11y-cloudflare-workers-stub.mjs", import.meta.url).href;
const CLOUDFLARE_CONTAINERS_STUB = new URL("./cloudflare-containers-stub.mjs", import.meta.url).href;

// `jose`, `source-map-js` (a `workers/o11y` devDependency, borrowed the same
// way for `pipeline/o11y-symbolicate.test.mjs`, which needs to build a real
// source map with `SourceMapGenerator` to test against — `drain/symbolicate.ts`
// itself resolves maps with `@jridgewell/trace-mapping`) and
// `@handsontable/demo-runtime` (any subpath) are
// `workers/o11y`'s dependencies, not the pipeline's — a plain node resolve
// only succeeds when the importing file lives under `workers/o11y/`, which
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
