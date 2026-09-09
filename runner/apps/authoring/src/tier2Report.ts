/**
 * What a Tier-2 compiler-diagnostic `stderr` line becomes in Sentry (DEV-2854, Sentry
 * DEMOS-3K/3M/4F/3H and friends).
 *
 * Split out of `sentry.ts` for the same reason as `tier1Report.ts` and `reportingGate.ts`:
 * that file pulls `@sentry/react` and reads `import.meta.env`, so `node --test` cannot
 * import it and nothing in it can be pinned by a unit test. Keep this module import-free —
 * the grouping rule is the whole of what it decides, and `pipeline/tier2-report.test.mjs`
 * imports it as source.
 *
 * DEV-2854 was filed against the wrong site and asked for a change that was already made:
 *
 *  - These events are `Sentry.captureMessage(...)` from `reportDemoEvent` below (reached
 *    via `ContainerRuntime.onStderr`), tagged `kind: "stderr"`, `level: "warning"`, Sentry
 *    `Type: default` — NOT `App.tsx`'s `Sentry.captureException(e, { tags: { context:
 *    "tier2-runtime" } })`. That catch-all's own issues are all `TypeError: Failed to
 *    fetch` and have never once carried a compiler diagnostic; this module has nothing to
 *    do with it and must not be wired there.
 *  - `normalizeMonitorMessage`'s quoted-string rule (used in the fingerprint at
 *    `sentry.ts:263` for every other `kind`) already collapses messages within one TS
 *    diagnostic code — DEMOS-3M holds six distinct quoted identifiers in one issue. Keying
 *    a new fingerprint on the code would be a no-op on top of that.
 *
 * What is actually broken, and what this module fixes:
 *
 *  1. **Title flap.** A fingerprint coarser than the message, with the raw message still in
 *     the title, means the issue title names whichever sample arrived last (the same
 *     defect `tier1Report.ts` documents for `COMPILE_TITLE`). DEMOS-3K's title says
 *     `',' expected` while its newest event says `')' expected`.
 *  2. **Cross-code spread.** One bad Angular-editing session mints 20+ distinct TS codes,
 *     each its own single-event issue, because nothing groups across codes.
 *
 * The fix is a flat fingerprint across every recognised diagnostic, a constant title, and
 * the code preserved as a facet (`ts_code`) rather than folded into either. That is the
 * **invariant to hold: constant title iff flat fingerprint** — a title that varies with the
 * code on a fingerprint that does not would flap exactly like today's does, which is why
 * there is no `"Tier-2 compile failed (TS1005)"` middle option here.
 *
 * The recogniser below is an **allowlist on purpose**: it matches a TS diagnostic code in
 * diagnostic position and nothing else. NG codes (`NG8001`, `NG8002` — plausibly our own
 * Angular starter's `HotTableModule` wiring), `Failure reason:`, `::…::` install-failure
 * markers, vite/vue internal errors, and `Could not resolve` are all untouched **by
 * construction** — they keep reporting through the unchanged bare-message path in
 * `sentry.ts`, so nothing that should stay loud goes quiet by falling through a denylist
 * gap. `pipeline/tier2-report.test.mjs` pins every one of those as a guard against a future
 * rewrite that swaps this allowlist for a denylist.
 */

/** The constant title for every recognised Tier-2 compiler diagnostic, for all time. The
 *  raw line it replaces rides in `extra.compileDiagnostic` instead, which takes no part in
 *  grouping or titling. */
const TIER2_COMPILE_TITLE = "Tier-2 compile failed";

/** A TS diagnostic code in diagnostic position — the code immediately followed by a colon
 *  and a space, as esbuild/tsc emit it (`TS1005: ',' expected.`). Requires a word boundary
 *  before `TS` and the trailing `: ` so a bare `TS1005` mentioned in prose, with no code
 *  frame around it, does not match. */
const TS_CODE_IN_DIAGNOSTIC_POSITION = /\bTS\d{4,5}:\s/;

/** Every code found in diagnostic position, for the multi-code check below. Kept as its own
 *  literal (not derived from `TS_CODE_IN_DIAGNOSTIC_POSITION` via `.source`, which would
 *  need its own `g` flag stitched on) but written to the identical shape by hand — the two
 *  must agree on what counts as "a code", so change them together. */
const TS_CODE_GLOBAL = /\bTS\d{4,5}(?=:\s)/g;

export interface Tier2StderrReport {
  fingerprint: string[];
  tags: Record<string, string>;
  extra: Record<string, string>;
  display: string;
}

/**
 * Decide how a Tier-2 `stderr` line is reported, or that it is not.
 *
 * `null` for anything other than `kind === "stderr"` with a recognised TS diagnostic code:
 * the caller keeps today's per-message fingerprint and title unchanged. Not reclassified,
 * not merged, no synthetic title — an unrecognised line needs nothing extra to keep working,
 * since `normalizeMonitorMessage`'s quoted-string rule already groups the no-code case
 * (DEMOS-3H's `Unexpected "}"` / `Unexpected ","`).
 */
export function tier2StderrReport(kind: string, message: string): Tier2StderrReport | null {
  if (kind !== "stderr") return null;
  if (!TS_CODE_IN_DIAGNOSTIC_POSITION.test(message)) return null;

  const codes = new Set<string>();
  for (const match of message.matchAll(TS_CODE_GLOBAL)) codes.add(match[0]);
  // First match wins for the tag; a line naming more than one distinct code (a repeated,
  // truncated diagnostic block) omits the tag rather than pick arbitrarily. The
  // fingerprint below is unaffected either way — it never carries a code.
  const singleCode = codes.size === 1 ? [...codes][0] : undefined;

  return {
    // Flat, never keyed on the code: per-code keying leaves ~20 issues per bad editing
    // session and is unbounded in the TS vocabulary. `framework` / `tier` deliberately
    // stay out too — they are already tags in `sentry.ts`, and the house rule there is
    // that instrumentation facets go beside the fingerprint, never inside it.
    fingerprint: ["demo-runtime", "stderr", "tier2-compile"],
    tags: {
      kind_class: "tier2-compile",
      ...(singleCode ? { ts_code: singleCode } : {}),
    },
    // The raw line, verbatim and bounded/host-redacted upstream by `sanitizeMonitorPayload`
    // — never in `display` or the fingerprint, which is what keeps the title constant.
    extra: { compileDiagnostic: message },
    display: TIER2_COMPILE_TITLE,
  };
}
