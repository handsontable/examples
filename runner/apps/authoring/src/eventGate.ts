// Two `beforeSend` suppression gates for populations the Sentry triage classified
// NOT-OURS (DEV-2858). Custom message filters are plan-locked on this project — one
// DSN across all three environments — so this has to be code.
//
// Split out of `sentry.ts` rather than written inline there, same reasoning as
// `reportingGate.ts:1-9` and `fetchFailure.ts:14-19`: that module imports
// `@sentry/react` and reads `import.meta.env`, neither of which node resolves, so
// nothing in it can be unit-tested. `pipeline/sentry-gating.test.mjs` imports THIS
// module directly under `--experimental-strip-types`, which cannot resolve sibling
// `./x.js` specifiers or npm packages. Do not let it grow imports — no `@sentry/react`
// types, no `./x.js` specifier, no `SessionStartDiagnostics` import. Parameters are
// structurally typed instead (same arrangement as `rehomeBudgetAlert` in
// `workers/api/src/sentry-gate.ts:82-84`).

/** The `exception` shape every gate below reads — declared locally, not
 *  imported, so this file stays resolvable by a bare `node --test`.
 *  `Sentry.ErrorEvent` satisfies this structurally already; a Faro
 *  `ExceptionEvent` (fix round D-I2, always exactly one error, no `values`
 *  array of its own) is adapted into this same one-entry-array shape at its
 *  call site (`telemetry/faro.ts`) so both surfaces share these predicates
 *  instead of drifting apart. */
interface ExceptionShape {
  exception?: {
    values?: {
      value?: string;
      type?: string;
      mechanism?: { handled?: boolean };
      stacktrace?: { frames?: { filename?: string }[] };
    }[];
  };
}

/** The `tags` shape `isEdgelessForeignSessionStart` reads. Declared locally for the
 *  same import-free reason as `ExceptionShape` above. */
interface TaggedEvent {
  tags?: Record<string, unknown>;
}

// ── Gate 0: browser noise that is never actionable ───────────────────────────────
//
// A benign layout-loop warning browsers surface as an error, plus the shapes an
// in-flight request takes when the user navigates away mid-fetch (`Failed to
// fetch` in Chrome, `Load failed` in Safari). Fix round D-I2: moved here from
// `sentry.ts` (unchanged in substance) so `telemetry/faro.ts`'s Faro `beforeSend`
// can apply the exact same rule Sentry's `beforeSend` already does — contract §6
// requires "the shared noise gates" for both, and until this fix round only
// Sentry ever saw them; every one of these shapes reached Faro/Loki AND, worse,
// could mint a fresh `fp:` entry and fire the §F.3 new-fingerprint alert.
//
// These must not go in a Sentry `ignoreErrors`-style pre-filter that runs before
// `handled` is known: that would silently discard the offline broker and
// `/api/versions` failures that `reportError`/`buildFacade().error` exist to
// surface on purpose.
const UNHANDLED_NOISE = [
  /^ResizeObserver loop/i,
  /^AbortError/i,
  /Failed to fetch/i,
  /Load failed/i,
];

/**
 * True for a global `onerror`/`onunhandledrejection` (or an ErrorBoundary render
 * crash — see `telemetry/faro.ts#reportUncaughtError`) event whose message is
 * known noise. `mechanism.handled === false` is what distinguishes those from
 * anything reported on purpose (an explicit `captureException`/facade `.error()`
 * call sets `handled: true`), matching every gate in this file.
 */
export function isUnhandledNoise(event: ExceptionShape): boolean {
  const values = event.exception?.values ?? [];
  return values.some(
    (v) =>
      v.mechanism?.handled === false &&
      UNHANDLED_NOISE.some((re) => re.test(v.value ?? "") || re.test(v.type ?? "")),
  );
}

// ── Gate 0b: cross-origin frames — the preview iframe / an injected script ──────
//
// The preview iframe runs arbitrary authored and imported example code, so a typo
// there is product output, not an application fault. Being cross-origin, the
// iframe cannot reach this window's error handlers at all; this is the backstop
// for whatever does arrive that way (the Sandpack bundler, a container preview
// host, an injected extension script). Fix round D-I2: moved here from
// `sentry.ts`, same reasoning as Gate 0 above.
//
// Scoped to `mechanism.handled === false`, same discriminator as every gate here
// — applied to every event, it would silently discard explicit `reportError`/
// ErrorBoundary reports whose stack merely *passed through* a foreign frame.
// `originOrigin` is passed in rather than read from `window.location.origin`
// directly, so this stays resolvable by a bare `node --test`.
export function isForeignUnhandled(event: ExceptionShape, originOrigin: string): boolean {
  const values = event.exception?.values ?? [];
  return values.some(
    (v) =>
      v.mechanism?.handled === false &&
      (v.stacktrace?.frames ?? []).some(
        (f) => f.filename?.startsWith("http") && !f.filename.startsWith(originOrigin),
      ),
  );
}

// ── Gate 1: DEMOS-5F — Microsoft Outlook/Office safelink scanner ────────────────
//
// The scanner injects script into the page that then throws its own unhandled
// rejection. One named regex, in the `fetchFailure.ts:29-32` house style, so an
// unrecognised wording surfaces as a new event instead of being folded in silently.
//
// Deliberately excluded from the pattern: the integers after `Id:` and
// `ParamCount:`, and `MethodName:` entirely. `MethodName` varies in the wild
// (`update`, `getInstance`, …) and the prose alone is already discriminating —
// dropping the integers beats `\d+`-ing them, since nothing downstream needs to
// know a number was there.
//
// DEGRADE DIRECTION, documented like `isPreviewPortUnreachable` /
// `isExpectedTeardownFailure` (`workers/api/src/session-lifecycle.ts:131-134`): this
// string comes from an injected third-party script, not from any package in this
// repo, so a Microsoft reword makes this predicate stop matching and the event
// reports again — noisy, never silent.
const INJECTED_SCANNER_MESSAGES = [
  /Object Not Found Matching Id/i, // Microsoft Outlook/Office safelink scanner
];

/**
 * True for an *unhandled* rejection/error whose text is the Office scanner's own
 * injected failure.
 *
 * Both conjuncts required, mirroring `isUnhandledNoise` above (this file):
 * `mechanism.handled === false` is what distinguishes an unhandled global-handler
 * event from anything reported on purpose (`captureException` sets
 * `handled: true`), and the message/type must match the scanner's wording. Without
 * the `handled` conjunct, an explicit `captureException` that happened to quote this
 * text (there is a test for exactly this) would be silently dropped too.
 */
export function isOfficeScannerRejection(event: ExceptionShape): boolean {
  const values = event.exception?.values ?? [];
  return values.some(
    (v) =>
      v.mechanism?.handled === false &&
      INJECTED_SCANNER_MESSAGES.some((re) => re.test(v.value ?? "") || re.test(v.type ?? "")),
  );
}

// ── Gate 2: DEMOS-9 — the edgeless-foreign session-start facet ──────────────────
//
// Tags only, set at `App.tsx:292-305` — a file DEV-2854 owns; a rename there makes
// this gate stop matching, fail-open (noisy, never silent).
//
// `context` is a scoping conjunct so a future, unrelated reuse of
// `session_response_origin` elsewhere in the app is not silently silenced by this
// gate. `session_status` is deliberately NOT a conjunct — precedent at
// `pipeline/session-start-failure.test.mjs:464`: "the tier turns on where the
// response came from, not on the status."
//
// `cf_ray` is checked for a non-empty string, not with `in` / presence, so a
// hypothetical empty-string tag counts as absent rather than as present-and-truthy.
//
// THE `!cf_ray` CONJUNCT IS UNREACHABLE TODAY — KEEP IT ANYWAY.
// `sessionDiagnostics.ts:58` (`responseOrigin`) returns `"cloudflare"` whenever
// `ray` is truthy, so `"foreign"` already implies no ray: every event this gate can
// see today has no `cf_ray` tag at all, which makes `!cf_ray` look like dead code.
// A reviewer may read it that way and cite the `session-lifecycle.ts:145-154` rule
// — "no create-path event of it exists, so widening this predicate for it would be
// a guess dressed as a fact" — as licence to delete it. That rule forbids WIDENING
// a predicate to cover an unobserved input. `!cf_ray` is the opposite: a NARROWING
// conjunct, and a narrowing conjunct can only ever suppress LESS than the gate
// would without it, never more. Direction is the discriminator, not observability.
// It keeps this gate correct if the `responseOrigin` taxonomy in
// `sessionDiagnostics.ts` ever changes shape and starts emitting `"foreign"` for a
// ray-bearing response — which would be OUR side of the edge (a real invocation,
// not an intercepted one) and the actual capacity signal DEMOS-9 exists to protect,
// so it must not be silenced by this gate no matter how the origin taxonomy drifts.
//
// THIS DOES NOT ZERO THE 786. The ~88 events predating the DEV-2559 instrumentation
// deploy carry no diagnostics tags at all and keep reporting — correctly: an
// untagged event carries no evidence of being not-ours, so there is nothing here
// for the gate to match.
export function isEdgelessForeignSessionStart(event: TaggedEvent): boolean {
  const tags = event.tags ?? {};
  const cfRay = tags.cf_ray;
  const hasRay = typeof cfRay === "string" && cfRay.length > 0;
  return (
    tags.context === "tier2-session-start" &&
    tags.session_response_origin === "foreign" &&
    !hasRay
  );
}
