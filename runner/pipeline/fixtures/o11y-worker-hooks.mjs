// Module hooks that make `workers/o11y/src/box.ts` loadable under plain
// `node --experimental-strip-types --test` — the same pattern
// `worker-hooks.mjs` uses for `workers/api/src/index.ts`, kept as a
// separate file (not an edit to the shared one) since this repo's o11y
// worker has its own module-resolution needs: a `.js`→`.ts` remap scoped to
// `workers/o11y/src/`, and `@cloudflare/containers` (imports
// `cloudflare:workers` at load time, only real inside workerd) redirected
// to `cloudflare-containers-stub.mjs`.

const CONTAINERS_STUB = new URL("./cloudflare-containers-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@cloudflare/containers") {
    return { url: CONTAINERS_STUB, shortCircuit: true };
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
