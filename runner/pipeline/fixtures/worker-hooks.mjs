// Module hooks that make the real router (workers/api/src/index.ts) loadable
// under plain `node --experimental-strip-types --test` — registered by
// pipeline/mcp-routes.test.mjs via `module.register()` before it imports the
// worker. `node --test` runs each spec file in its own process, so nothing
// here leaks into the other pipeline specs.
//
// Two obstacles, two rewrites:
//
// - The worker's modules import each other by `.js` specifier (the shape the
//   Workers bundler resolves), but the files on disk are `.ts`, and Node's
//   resolver has no extension fallback — the same limitation that made
//   theme-codegen.test.mjs read its subject as text. Map the extension, only
//   for relative imports inside the worker's own source tree.
//
// - `@cloudflare/sandbox` imports the `cloudflare:` URL scheme at load time,
//   which only exists inside workerd. The routes under test never reach a
//   sandbox, so a structural stub stands in for the package.

const SANDBOX_STUB = new URL("./cloudflare-sandbox-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@cloudflare/sandbox") {
    return { url: SANDBOX_STUB, shortCircuit: true };
  }
  if (
    specifier.startsWith(".")
    && specifier.endsWith(".js")
    && context.parentURL?.includes("/workers/api/src/")
  ) {
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
  return nextResolve(specifier, context);
}
