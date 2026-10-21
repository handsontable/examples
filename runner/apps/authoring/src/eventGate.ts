// `beforeSend` suppression gates for populations the Sentry triage classified
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

/** The `exception` shape every gate below reads. A Faro `ExceptionEvent` is
 *  adapted into this same shape at its call site (`telemetry/faro.ts`). */
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

/** The `tags` shape `applyFaroTee` writes. Declared locally for the same
 *  import-free reason as `ExceptionShape` above. */
interface TaggedEvent {
  tags?: Record<string, unknown>;
}

// ── Gate 0: browser noise that is never actionable ──────────────────────────────
//
// Shared here (not just `sentry.ts`) so Faro's `beforeSend` applies the same
// rule (contract §6). Not a Sentry `ignoreErrors` pre-filter, which runs
// before `handled` is known and would drop on-purpose reports too.
const UNHANDLED_NOISE = [
  /^ResizeObserver loop/i,
  /^AbortError/i,
  /Failed to fetch/i,
  /Load failed/i,
];

/** True for a global `onerror`/`onunhandledrejection` (or an ErrorBoundary
 *  render crash) event whose message is known noise. `handled === false`
 *  distinguishes those from anything reported on purpose. */
export function isUnhandledNoise(event: ExceptionShape): boolean {
  const values = event.exception?.values ?? [];
  return values.some(
    (v) =>
      v.mechanism?.handled === false &&
      UNHANDLED_NOISE.some((re) => re.test(v.value ?? "") || re.test(v.type ?? "")),
  );
}

// ── Gate 0b: cross-origin frames — the preview iframe / an injected script ─────
//
// The preview iframe runs arbitrary example code — a typo there is product
// output, not an app fault — and is cross-origin, so this is the backstop.
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

// ── Strip Faro's message-echo pseudo-frames before Gate 0b runs ────────────────
//
// Faro can turn the `Error: <message>` line itself into a fake frame with no
// `lineno` when the message quotes a URL, which `isForeignUnhandled` would
// misread as foreign. A real frame always has a `lineno`.
export function withoutMessageEchoFrames<F extends { filename?: string; lineno?: number }>(
  value: string | undefined,
  frames: F[] | undefined,
): F[] | undefined {
  if (!frames || !value) return frames;
  return frames.filter((f) => typeof f.lineno === "number" || !f.filename || !value.includes(f.filename));
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

// ── ADR §E.2 tee ─────────────────────────────────────────────────────────────
//
// Split out of `sentry.ts`; `telemetry`'s shape is structural, so a stub
// can test this without importing the real facade.

/** The `telemetry` facade shape this tee needs — structurally typed against
 *  `Telemetry` (contract §6), not imported, for the reason above. */
interface TelemetryTeeTarget {
  pageLoadId(): string;
  event(name: string, attributes: Record<string, string>): void;
}

/** ADR §E.2: the Faro page-load id becomes a Sentry tag, and the Sentry
 *  event id is pushed as a Faro event, on every event that ships. Wrapped
 *  in try/catch: a throw would otherwise make the SDK drop the event. */
export function applyFaroTee<E extends TaggedEvent & { event_id?: string }>(event: E, telemetry: TelemetryTeeTarget): E {
  try {
    event.tags = { ...event.tags, page_load_id: telemetry.pageLoadId() };
    telemetry.event("sentry.event", { sentry_event_id: event.event_id ?? "" });
  } catch {
    // best-effort tee only — the caller still ships `event` regardless.
  }
  return event;
}
