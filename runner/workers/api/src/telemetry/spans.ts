// Custom spans (ADR-0041 §D) around session start, container boot, snapshot
// build, chat, theme AI, import and payload boot — for the dashboard view.
// Cloudflare exposes this as `cloudflare:workers`' `tracing.enterSpan`, a
// runtime-provided module with no `@cloudflare/workers-types` ambient
// declaration old enough to assume present everywhere this code runs
// (`wrangler dev` on an older workerd, or `pipeline/`'s plain Node import of
// this file) — hence "feature-detected" (task Scope): a dynamic `import()` of
// the virtual specifier, caught rather than awaited at module top level, so a
// runtime without it (or without the module at all, e.g. plain Node) silently
// falls back to "just run the callback".
//
// Traces are never exported to a destination (contract §1: "There is no trace
// route"; `wrangler.jsonc`'s `observability.traces` sets no `destinations`) —
// this only feeds Cloudflare's own 1%-sampled dashboard view (ADR §F.2).

interface WorkersTracing {
  enterSpan<T>(name: string, callback: () => T): T;
}

const tracingApi: Promise<WorkersTracing | null> = (async () => {
  try {
    const mod = (await import("cloudflare:workers")) as { tracing?: WorkersTracing };
    return typeof mod.tracing?.enterSpan === "function" ? mod.tracing : null;
  } catch {
    return null;
  }
})();

/**
 * Run `fn` inside a span named `name` when the runtime supports it, otherwise
 * just run it. Safe under `pipeline/`'s plain-Node import (the dynamic import
 * above rejects there, caught once, and every call after that is a plain
 * passthrough) and under any workerd build old enough not to export `tracing`.
 */
export async function withSpan<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const tracing = await tracingApi;
  if (!tracing) return fn();
  return tracing.enterSpan(name, () => fn());
}
