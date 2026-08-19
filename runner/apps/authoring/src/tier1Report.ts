/**
 * What a Tier-1 preview failure becomes in Sentry (DEV-2569, Sentry DEMOS-15).
 *
 * Split out of `App.tsx` for the same reason as `reportingGate.ts` and
 * `sessionDiagnostics.ts`: that file pulls `@sentry/react` and `import.meta.env`, so
 * `node --test` cannot import it and nothing in it can be pinned by a unit test. Keep
 * this module import-free — the grouping rules are the whole of what it decides, and
 * `pipeline/tier1-report.test.mjs` imports it as source.
 *
 * Two populations used to share one issue, and the mix is what made DEMOS-15 unreadable:
 *
 *  - **The visitor's own source.** A bundler diagnostic for a module that never ran is a
 *    code frame over code an anonymous visitor is typing. Default grouping would shard
 *    that into an issue per typo, so the fingerprint is flat — and *because* it is flat,
 *    the message must not be part of the event title. A Sentry issue re-derives its title
 *    from the newest event, so a per-event message makes the title name whichever typo
 *    arrived last. The constant title below is what stops that; the real diagnostic rides
 *    in `extra`, which takes no part in grouping or titling.
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
  /** The chunk URL, when the engine named one (`CompilerUnavailableError.assetUrl`). */
  assetUrl?: string | null;
  /** The DEV-2527 demo-monitoring flag. Deliberately an input, so the gate ORDER is tested. */
  monitorDemos: boolean;
}

export interface Tier1Report {
  tags: Record<string, string>;
  fingerprint: string[];
  level: "warning" | "error";
  /** Capture a synthetic error with exactly this name and message instead of the original,
   *  so the issue title is a class of failure rather than one sample of it. */
  synthesizeAs: { name: string; message: string };
  extra: Record<string, string>;
}

/** The title of the compiler-asset issue, for all time. One constant, not two: a Sentry
 *  issue re-derives its title from the newest event, so a message that varied with the
 *  retry state would make the title flap between them. */
const COMPILER_ASSET_TITLE = "Tier-1 preview compiler asset failed to load";

/** The title of the visitor-source compile issue, for all time. The code frame it replaces
 *  is in `extra.compileDiagnostic`. */
const COMPILE_TITLE = "Tier-1 compile failed";

/**
 * Decide how a Tier-1 error is reported, or that it is not.
 *
 * Order is load-bearing twice.
 *
 * The compiler-asset branch comes **first, ahead of the `monitorDemos` gate**. That flag is
 * DEV-2527's temporary demo instrumentation and has a documented teardown
 * (`docs/run-and-deploy.md`); our own asset failing to load has to outlive it, or removing
 * the flag silently stops reporting the one failure in this file that is ours to fix. It is
 * also the reason this branch carries `context:` rather than `surface: "demo-runtime"`:
 * `beforeSend` in `sentry.ts` re-homes anything with that surface into the `demo-runtime`
 * environment, which is where visitor noise lives and gets filtered past.
 *
 * The evaluated-throw stand-down (DEV-2552) comes next: a throw from a module that already
 * started evaluating belongs to the in-preview reporter, which files it with the preview's
 * own stack, tier, framework and demo id. Reporting it here as well filed one fault twice.
 */
export function tier1Report(facts: Tier1ErrorFacts): Tier1Report | null {
  if (facts.compilerUnavailable) {
    return {
      tags: { context: "tier1-compiler-asset", tier: "1" },
      fingerprint: ["tier1-compiler-asset"],
      // Ours, not product output — the one Tier-1 branch that is not a warning.
      level: "error",
      synthesizeAs: { name: "CompilerUnavailableError", message: COMPILER_ASSET_TITLE },
      extra: {
        // Never in the title or the fingerprint: the URL is hashed per build, so a title
        // carrying it names one deploy's sample and a fingerprint carrying it opens a new
        // issue every deploy.
        ...(facts.assetUrl ? { assetUrl: facts.assetUrl } : {}),
        cause: facts.message,
      },
    };
  }
  if (facts.name === "SandpackEvaluationError") return null;
  if (!facts.monitorDemos) return null;
  return {
    tags: { surface: "demo-runtime", kind: "sandpack-compile", tier: "1" },
    // Byte-identical to what shipped before, so the live issue does not regroup.
    fingerprint: ["demo-runtime", "sandpack-compile"],
    level: "warning",
    synthesizeAs: { name: "Tier1CompileError", message: COMPILE_TITLE },
    // Bounded to 2000 chars and host-redacted upstream by `boundCompileMessage`.
    extra: { compileDiagnostic: facts.message },
  };
}
