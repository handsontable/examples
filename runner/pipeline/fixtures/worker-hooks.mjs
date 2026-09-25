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
//
// - `@sentry/cloudflare` likewise expects a Workers runtime. Nothing under
//   test needs live reporting (see sentry-cloudflare-stub.mjs for why), but a
//   spec that wants to assert on a `Sentry.captureException` call needs
//   somewhere to observe it — a plain "does not crash" stub would leave that
//   untestable. Additive only: every symbol used in workers/api/src passes
//   through or no-ops, so specs that assert nothing about Sentry are
//   unaffected.
//
// - `cloudflare:workers` (T04): `index.ts` now re-exports `O11yUsage`
//   (`o11y-usage.ts`), a `WorkerEntrypoint` — reuses the same structural
//   stub `o11y-worker-hooks.mjs` already uses for `workers/o11y/src`,
//   rather than a second copy (COMMON.md: "don't keep two diverging"
//   spirit, applied to test fixtures too).

const SANDBOX_STUB = new URL("./cloudflare-sandbox-stub.mjs", import.meta.url).href;
const SENTRY_STUB = new URL("./sentry-cloudflare-stub.mjs", import.meta.url).href;
const CLOUDFLARE_WORKERS_STUB = new URL("./o11y-cloudflare-workers-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@cloudflare/sandbox") {
    return { url: SANDBOX_STUB, shortCircuit: true };
  }
  if (specifier === "@sentry/cloudflare") {
    return { url: SENTRY_STUB, shortCircuit: true };
  }
  if (specifier === "cloudflare:workers") {
    return { url: CLOUDFLARE_WORKERS_STUB, shortCircuit: true };
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
