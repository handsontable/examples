/**
 * What a Tier-1 preview failure becomes in the telemetry facade (DEV-2569, DEMOS-15).
 *
 * Split out of `App.tsx` for the same reason as `reportingGate.ts` and
 * `sessionDiagnostics.ts`: that file pulls `@sentry/react` and `import.meta.env`, so
 * `node --test` cannot import it and nothing in it can be pinned by a unit test. Keep
 * this module import-free — `pipeline/tier1-report.test.mjs` imports it as source.
 *
 * Two populations, kept apart:
 *
 *  - **The visitor's own source.** A bundler diagnostic for a module that never ran is a
 *    code frame over code an anonymous visitor is typing, so the record carries a constant
 *    title — a per-event message would make every typo its own error class.
 *
 *  - **Our own compiler chunk failing to load.** Not a typo, not the visitor's fault, and
 *    not demo monitoring — see `tier1Report` for why it is neither gated nor tagged like
 *    the rest of this surface.
 */

/** Everything the decision needs, extracted at the callsite so this module imports nothing. */
export interface Tier1ErrorFacts {
  /** `error.name`, as constructed by `packages/runtime` (never the raw babel/bundler name). */
  name: string;
  /** `error.message` — for the compile branch this is the bounded, host-redacted code frame. */
  message: string;
  /** `isCompilerUnavailable(e)` from the runtime: our own compiler asset never arrived. */
  compilerUnavailable: boolean;
  /** `CompilerUnavailableError.replay`: the latch re-throwing a failure already reported. */
  replay?: boolean;
  /** `navigator.onLine`. `false` is proof the visitor's network is down, so the failure is
   *  not ours; `true` proves nothing, so it is not treated as evidence either way. */
  online?: boolean;
  /** `isOpaqueNetworkFailure(e)`: the browser's own transport failure, e.g. the mount's
   *  `TypeError: Failed to fetch` when the bundler cannot be reached. */
  opaqueNetworkFailure?: boolean;
  /** The DEV-2527 demo-monitoring flag. Deliberately an input, so the gate ORDER is tested. */
  monitorDemos: boolean;
}

export interface Tier1Report {
  tags: Record<string, string>;
  /** Report a synthetic error with exactly this name and message instead of the original,
   *  so the record is titled by its class of failure rather than one sample of it. */
  synthesizeAs: { name: string; message: string };
}

/** The title of the compiler-asset record. One constant, not two: a message that varied
 *  with the retry state would split one failure class in two. */
const COMPILER_ASSET_TITLE = "Tier-1 preview compiler asset failed to load";

/** The title of the visitor-source compile record. */
const COMPILE_TITLE = "Tier-1 compile failed";

/**
 * Decide how a Tier-1 error is reported, or that it is not.
 *
 * Order is load-bearing three times.
 *
 * The compiler-asset branch comes **first, ahead of the `monitorDemos` gate**. That flag is
 * DEV-2527's demo instrumentation; our own asset failing to load has to outlive it, or
 * turning the flag off silently stops reporting the one failure in this file that is ours to
 * fix. It is also why this branch carries `context:` rather than `surface: "demo-runtime"`,
 * which is where visitor noise lives.
 *
 * The evaluated-throw stand-down (DEV-2552) comes next: a throw from a module that already
 * started evaluating belongs to the in-preview reporter, which files it with the preview's
 * own stack, tier, framework and demo id. Reporting it here as well filed one fault twice.
 *
 * The opaque transport failure (the mount's `TypeError: Failed to fetch`) stands down third,
 * after both of those and before the `monitorDemos` gate: it is not a diagnostic about the
 * visitor's code, and `sandpack.bundler_unreachable` already counts it.
 */
export function tier1Report(facts: Tier1ErrorFacts): Tier1Report | null {
  if (facts.compilerUnavailable) {
    // Reported once per failure, not once per keystroke: after the first terminal failure
    // the loader latches and re-throws, and the shell has already carded it.
    if (facts.replay) return null;
    // A visitor who is offline is not evidence of anything we can fix, and this branch has
    // no flag gate on it — so the one signal that separates "our asset is gone" from "this
    // visitor has no network" is used before the record is sent. `online === true` proves
    // nothing (an extension or proxy still refuses the request), so only an explicit
    // `false` suppresses.
    if (facts.online === false) return null;
    return {
      tags: { context: "tier1-compiler-asset", tier: "1" },
      synthesizeAs: { name: "CompilerUnavailableError", message: COMPILER_ASSET_TITLE },
    };
  }
  if (facts.name === "SandpackEvaluationError") return null;
  // The bundler never loaded on the visitor's network: nothing about their source, and
  // `sandpack.bundler_unreachable` already counts it.
  if (facts.opaqueNetworkFailure) return null;
  if (!facts.monitorDemos) return null;
  return {
    tags: { surface: "demo-runtime", kind: "sandpack-compile", tier: "1" },
    synthesizeAs: { name: "Tier1CompileError", message: COMPILE_TITLE },
  };
}
