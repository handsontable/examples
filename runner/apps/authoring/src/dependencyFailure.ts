/**
 * Which of two causes put Sandpack's "could not fetch dependencies" message in front
 * of a visitor (DEV-2872, Sentry DEMOS-15 / DEMOS-85).
 *
 * Split out of `App.tsx` for the same reason as `tier1Report.ts`, `fetchFailure.ts`
 * and `sessionDiagnostics.ts`: that file pulls `@sentry/react` and reads
 * `import.meta.env`, so `node --test` cannot import it, and nothing in it can be
 * pinned by a unit test. Keep this module import-free — the discriminator below is
 * the whole of what it decides, and `pipeline/dependency-failure.test.mjs` imports it
 * as source under `--experimental-strip-types`. Do not let this file grow imports.
 *
 * WHY NOW. DEV-2855 guarded `buildSetup` so an unparseable `/package.json` no longer
 * aborts `mount()`. That fix is correct and stays — before it, the preview died and
 * every later keystroke was silently swallowed until "Restart preview". But it changed
 * *which* message reaches `describeRuntimeError`: the mount now survives, the bundler
 * fails trying to resolve dependencies out of a manifest it cannot parse, and that
 * failure carries the exact same "could not fetch dependencies" wording Sandpack uses
 * for an unpublished/unresolvable Handsontable version. Both populations now land on
 * one branch in `App.tsx` that used to have only one cause.
 *
 * THE DISCRIMINATOR IS OUR OWN FILE STATE, NOT THIRD-PARTY TEXT. The two causes are
 * told apart by whether the authored `/package.json` parses as JSON — not by matching
 * on `Cannot read properties of null (reading 'match')`, which is Sandpack's bundler
 * choking on a manifest with no resolvable `dependencies` object. That wording is
 * undocumented upstream behaviour; keying on it would stop discriminating the moment
 * the bundler is bumped and phrases its own internal failure differently. Reading our
 * own file's parseability is stable regardless of how the bundler happens to fail on
 * it. The branch *entry* — `/could not fetch dependencies/i` — still keys on Sandpack's
 * wording, which is fine: that regex only gates onto our decision below and fails open
 * (returns the bundler's own message, via `App.tsx`'s existing `return msg`) rather
 * than fabricating a wrong answer.
 *
 * WHY THE PARSE DETAIL IS ASSERTED LOOSELY. `jsonSyntaxError` below hands back
 * whatever `JSON.parse` throws for `.message`, verbatim. That wording is
 * engine-specific — `fetchFailure.ts`'s header documents the same divergence for
 * Chrome/Firefox/Safari network error strings — so a test (or this docblock) must not
 * assert a particular V8 sentence; the shape (a non-empty detail string) is the
 * contract, not the words.
 *
 * RESIDUAL, OUT OF SCOPE. A syntactically *valid* `/package.json` pinned to a bogus
 * non-Handsontable dependency still fails the same way and still gets the npm
 * sentence below — that manifest parses fine, so `jsonSyntaxError` returns `null` and
 * this module falls through to the version-not-published wording. Fixing that would
 * require keying on the bundler's own error text for "this specific package doesn't
 * exist", which is exactly the third-party-text dependency this module exists to
 * avoid. Left alone deliberately.
 */

export interface DependencyFailureFacts {
  /** Which preview engine raised the error. Only "sandpack" (Tier 1) is ever this
   *  module's branch — the container engine (Tier 2) has its own DEV-2538/DEV-2553
   *  contract and must never be perturbed here. */
  engine: string;
  /** `e.message`, exactly as the shell received it from the runtime — the bounded
   *  `show-error` text, not a Sentry-rendered cause chain (that tail is `Error`'s own
   *  `cause` formatting and never reaches this module). */
  message: string;
  /** The pinned Handsontable version ref, for the npm sentence. */
  version: string;
  /** The authored `/package.json` text at error time, or `undefined` if the file
   *  doesn't exist in this workspace. */
  packageJson: string | undefined;
}

/**
 * `JSON.parse(raw)` and report why it failed, or `null` if it parses.
 * The message is whatever the engine's `JSON.parse` throws — see the docblock above
 * for why that wording is never asserted verbatim.
 */
function jsonSyntaxError(raw: string): string | null {
  try {
    JSON.parse(raw);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Decide how a Sandpack "could not fetch dependencies" failure should be explained,
 * or that this isn't that failure at all.
 *
 * `null` means "not my branch" — the caller (`describeRuntimeError` in `App.tsx`)
 * falls through to its existing `return msg`, the bundler's own message verbatim.
 */
export function describeDependencyFailure(facts: DependencyFailureFacts): string | null {
  if (facts.engine !== "sandpack") return null;
  if (!/could not fetch dependencies/i.test(facts.message)) return null;

  if (facts.packageJson !== undefined) {
    const detail = jsonSyntaxError(facts.packageJson);
    if (detail) {
      return `/package.json is not valid JSON, so this demo's dependencies could not be installed: ${detail}. Fix the file — the preview rebuilds itself on the next clean compile.`;
    }
  }

  // Either the manifest is undefined (deliberate status-quo preservation — DEV-2872
  // does not change this case) or it parses fine, in which case the real cause is
  // Sandpack's own: an unresolvable/unpublished version. Byte-identical to the
  // sentence `App.tsx` used before this module existed, so no behaviour changes here.
  return `Handsontable ${facts.version} could not be fetched. Check that this exact version is published on npm.`;
}
