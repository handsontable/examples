// Faro init + the contract §6 `Telemetry` facade backed by it (ADR §E.4). Not
// import-free — pulls in `@grafana/faro-web-sdk` and the telemetry contract
// module, same constraint class as `sentry.ts`: no test imports this file
// directly.
//
// Instrumentations: errors + web-vitals only (Performance, CSP, console and
// view instrumentations off — they send full URLs or console text, ADR §E.4).
// Session tracking disabled entirely — the facade sets `session.id` to the
// page-load id on every item itself, via a `metas.add` getter, rather than
// letting Faro mint and persist its own session. No tracing package is
// imported or configured (ADR §C.4: no trace is ever exported).
import {
  ErrorsInstrumentation,
  WebVitalsInstrumentation,
  initializeFaro,
  type BeforeSendHook,
  type Faro,
  type TransportItem,
} from "@grafana/faro-web-sdk";
import {
  scrubTelemetry,
  fingerprint as contractFingerprint,
  ATTR_HOT_SURFACE,
  ATTR_HOT_TIER,
  ATTR_HOT_FRAMEWORK,
  ATTR_HOT_HT_MAJOR,
  ATTR_HOT_OUTCOME,
  ATTR_HOT_DEMO_ID,
  ATTR_HOT_METRIC_KIND,
  ATTR_HOT_REF,
  ATTR_HOT_AREA,
  ATTR_HOT_BUCKET,
  ATTR_HOT_REASON,
  ATTR_HOT_FINGERPRINT,
  type EventName,
  type HotAttrs,
  type MetricName,
  type MetricValues,
  type ScrubbableFaroItem,
  type Telemetry,
} from "@handsontable/demo-runtime/telemetry";
import { resolveTelemetryEnabled, telemetryEnvironment } from "./gate.js";
import {
  isForeignUnhandled,
  isOfficeScannerRejection,
  isUnhandledNoise,
  withoutMessageEchoFrames,
} from "../eventGate.js";

/**
 * Fix round D-I2: contract §6 requires `beforeSend` = `scrubTelemetry` THEN
 * the shared noise gates — before this fix, only `sentry.ts`'s `beforeSend`
 * ever ran them, so every browser-noise shape Sentry has always dropped
 * (the ResizeObserver loop warning, a navigation-abort `Failed to fetch`/
 * `Load failed`, a foreign-origin extension frame, the Outlook/Office
 * safelink scanner's injected rejection) reached Faro/Loki instead, and —
 * because `surface` defaults to `authoring` and these are all
 * `handled: false` — could mint a fresh `fp:` first-seen entry and fire the
 * §F.3 new-fingerprint alert, the exact replacement ADR §E.1 promises for
 * Sentry's own "new issue" signal.
 *
 * `eventGate.ts`'s `ExceptionShape`-typed gates (`isUnhandledNoise`,
 * `isOfficeScannerRejection`, `isForeignUnhandled`) are Sentry-shaped
 * (`{ exception: { values: [...] } }`, one entry per error in a chain) — a
 * Faro `ExceptionEvent` is a single flat `value`/`type`/`stacktrace`/
 * `context`, so it is adapted into that same one-entry-array shape here
 * rather than duplicating (or Faro-ifying) the gates themselves.
 * `eventGate.ts`'s fourth gate, `isEdgelessForeignSessionStart`, reads
 * Sentry-only `tags` Faro never carries and does not apply here.
 * `context.handled` is the Faro-side equivalent of
 * Sentry's `mechanism.handled`: only `buildFacade().error()` below (an
 * explicit, on-purpose report) ever sets `"true"` — a raw
 * `ErrorsInstrumentation` catch (`window.onerror`/`unhandledrejection`) and
 * `reportUncaughtError`'s render-crash relay both leave it unset, exactly
 * mirroring which events carry Sentry's `mechanism.handled === false`.
 */
function faroExceptionToExceptionShape(payload: ScrubbableFaroItem["payload"]) {
  return {
    exception: {
      values: [
        {
          value: payload.value,
          type: payload.type,
          mechanism: { handled: payload.context?.handled === "true" },
          stacktrace: payload.stacktrace,
        },
      ],
    },
  };
}

/** Every item passes through the one contract scrubber before transport
 *  (ADR §E.4) — the exact cast pair T00-D11 documents as the unavoidable
 *  boundary between Faro's real item union (which includes `TraceEvent`,
 *  never exported here) and this module's narrower `ScrubbableFaroItem`.
 *  D-I2: an `exception` item is then run through the shared noise gates,
 *  same as Sentry's own `beforeSend` — AFTER scrubbing, so a gate never
 *  reads pre-scrub content.
 *
 *  R3 F17a: BEFORE scrubbing, an `exception` item's stack frames are run
 *  through `withoutMessageEchoFrames` on the RAW (unstripped) message —
 *  `scrubTelemetry` already strips the query/fragment off a frame's
 *  `filename`, which would break the substring match this needs against the
 *  message text quoting that same URL in full. This drops Faro's fake
 *  message-echo frame (see `eventGate.ts`) before Gate 0b
 *  (`isForeignUnhandled`) ever sees it, and also removes the duplicated
 *  message text from the stored body — a real frame (e.g.
 *  `at native (<anonymous>)`) always has a `filename` that is not a
 *  substring of the message, so it survives untouched. */
const beforeSend: BeforeSendHook = (item) => {
  const raw = item as unknown as ScrubbableFaroItem;
  const candidate: ScrubbableFaroItem =
    raw.type === "exception" && raw.payload.stacktrace
      ? {
          ...raw,
          payload: {
            ...raw.payload,
            stacktrace: {
              ...raw.payload.stacktrace,
              frames: withoutMessageEchoFrames(raw.payload.value, raw.payload.stacktrace.frames),
            },
          },
        }
      : raw;
  const scrubbed = scrubTelemetry(candidate) as ScrubbableFaroItem | null;
  if (!scrubbed) return null;
  if (scrubbed.type === "exception") {
    const shape = faroExceptionToExceptionShape(scrubbed.payload);
    if (
      isUnhandledNoise(shape) ||
      isOfficeScannerRejection(shape) ||
      isForeignUnhandled(shape, window.location.origin)
    ) {
      return null;
    }
  }
  return scrubbed as unknown as TransportItem;
};

/**
 * `scrub.ts#allowlistAttributes` keeps only the allowlisted keys
 * (`attrs.ts#ALLOWED_ATTRIBUTE_KEYS`) — a bare `HotAttrs` key like `surface`
 * is not one of them and is silently dropped by the scrubber that runs in
 * `beforeSend`, BEFORE the request ever leaves the browser (confirmed with a
 * live capture against a real `vite preview` build, not assumed — see T06-D1
 * in the task Outcome). This maps:
 *
 * - the six `HotAttrs` fields with a dotted RESOURCE-attribute equivalent
 *   (`surface`→`hot.surface` etc) — survive as §3 resource attributes/Loki
 *   labels.
 * - `kind`/`ref`/`area` → `hot.metric_kind`/`hot.ref`/`hot.area` (T12,
 *   ADR-0042) and `bucket`/`reason`/`fingerprint` → `hot.bucket`/
 *   `hot.reason`/`hot.fingerprint` (T07 fix round, controller ruling) —
 *   `attrs.ts#AE_ONLY_ATTRIBUTE_KEYS`, T02-D4's AE-only channel
 *   (`workers/o11y/src/normalise/browser-attrs.ts#readAeOnlyAttrs`): these
 *   survive the allowlist too, but `convert.ts#hoistAttributes` never hoists
 *   them into a stored record — only `toAePoint` (via `readAeOnlyAttrs`) ever
 *   reads them. NOT a resource attribute, NOT a Loki label. `kind` in
 *   particular cannot use the bare dotted name `hot.kind` — that key is
 *   already reserved for the Faro item kind and always overwritten
 *   server-side (T02-D4) — hence `hot.metric_kind`.
 *
 * Every other `HotAttrs` field (`route_class`, `model`, `provider`, `device`)
 * still has no equivalent and is sent unmapped — no browser call site needs
 * one yet (T02-D4's remaining AE-only columns).
 */
const DOTTED_ATTR_KEY: Partial<Record<string, string>> = {
  surface: ATTR_HOT_SURFACE,
  tier: ATTR_HOT_TIER,
  framework: ATTR_HOT_FRAMEWORK,
  ht_major: ATTR_HOT_HT_MAJOR,
  outcome: ATTR_HOT_OUTCOME,
  demo_id: ATTR_HOT_DEMO_ID,
  kind: ATTR_HOT_METRIC_KIND,
  ref: ATTR_HOT_REF,
  area: ATTR_HOT_AREA,
  bucket: ATTR_HOT_BUCKET,
  reason: ATTR_HOT_REASON,
  fingerprint: ATTR_HOT_FINGERPRINT,
};

/** Stringify a `HotAttrs` bag for Faro's `Record<string, string>`
 *  context/attributes, dropping `undefined` fields and remapping the six keys
 *  above to their dotted equivalent so the scrubber's allowlist keeps them.
 *  Every `HotAttrs` field is already a string union or a bare `string` at the
 *  type level (`attrs.ts`), so this never actually coerces a non-string value
 *  — the `String(...)` is defensive, not a real conversion.
 *
 *  Parameter typed as the index-signature-free `object`, not
 *  `Record<string, string | undefined>`: `HotAttrs` itself carries no index
 *  signature, and TS requires a *source* type to also declare one when the
 *  *target* parameter type does — the same friction T00-D11 documents for
 *  `scrub.ts`'s Faro-shape types. */
function attrsToContext(attrs?: object): Record<string, string> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out[DOTTED_ATTR_KEY[key] ?? key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildFacade(faro: Faro, pageLoadId: string): Telemetry {
  return {
    // Z-D-H1 fix: `skipDedupe: true` on both calls below. `initializeFaro`
    // (below) passes no `dedupe` override, so faro-core's `makeCoreConfig`
    // default `dedupe = true` still applies GLOBALLY — this is what still
    // collapses a `window.onerror`/`unhandledrejection` storm for
    // `pushError` (unaffected by this fix; `error()` below is untouched).
    // But faro-core's event/measurement dedupe keeps exactly ONE
    // `lastPayload` per API and skips a push whenever it deep-equals the
    // PREVIOUS push, with no time window — so two `example.saved` (or
    // `example.open` on a guide's second example — see H1's `ref`-only
    // taxonomy) calls with an identical attribute bag back-to-back silently
    // drop the second one before it ever leaves the browser. Server-side
    // redelivery hashing (`normalise/faro.ts`) already includes the client
    // `timestamp`, and AE-only `example.*` points are never hashed at all,
    // so this client-side collapse buys no real dedupe value for these two
    // calls — only silent data loss on every legitimate repeat action.
    metric(name: MetricName, values: MetricValues, attrs: HotAttrs) {
      faro.api.pushMeasurement(
        { type: name, values: { ...values } as unknown as Record<string, number> },
        { context: attrsToContext(attrs), skipDedupe: true },
      );
    },
    event(name: EventName, attrs: HotAttrs & Record<string, string>) {
      faro.api.pushEvent(name, attrsToContext(attrs), undefined, { skipDedupe: true });
    },
    // A HANDLED error only (contract §6 doc on `Telemetry.error`) — always
    // tagged `context.handled = "true"` so the o11y worker's ingest-time split
    // (contract §6 table) files it as `error.handled`, never `error.uncaught`.
    // An uncaught render crash goes through `reportUncaughtError` below
    // instead, which is NOT part of the pinned `Telemetry` interface — see its
    // own doc comment for why.
    error(err: unknown, context: string, attrs?: HotAttrs) {
      const error = err instanceof Error ? err : new Error(String(err));
      faro.api.pushError(error, {
        context: { handled: "true", context, ...(attrsToContext(attrs) ?? {}) },
        fingerprint: contractFingerprint(context, error.message),
      });
    },
    pageLoadId: () => pageLoadId,
  };
}

export interface InitFaroOptions {
  /** The page-load id already minted by `noopTelemetry` (contract facade.ts) —
   *  reused, not re-minted, so a call to `apiHeaders()` before `initTelemetry()`
   *  runs and one after both carry the identical id for the life of the page. */
  pageLoadId: string;
  /** `resolveReporting(...).enabled` (`reportingGate.ts`) — the SAME
   *  production/automation gate Sentry uses (task Scope: "production via
   *  resolveReporting unchanged"). */
  productionReportingEnabled: boolean;
  /** `import.meta.env.VITE_SENTRY_RELEASE` — the same full git SHA Sentry
   *  tags its events with, so a Faro `app.version` and a Sentry `release` name
   *  the same deploy. */
  release: string | undefined;
}

let faroInstance: Faro | null = null;

/**
 * Initialise Faro and return the facade backed by it, or `null` when the gate
 * is closed (production automation, or no local-flag/host match) — the caller
 * keeps `noopTelemetry` in that case and this module stays fully inert (no
 * `initializeFaro` call, no global patched, nothing to tear down).
 */
export function initFaroTelemetry(options: InitFaroOptions): Telemetry | null {
  const hostname = typeof window !== "undefined" ? window.location.hostname : undefined;
  const localFlag = import.meta.env.VITE_TELEMETRY_LOCAL as string | undefined;
  const enabled = resolveTelemetryEnabled({
    productionReportingEnabled: options.productionReportingEnabled,
    localFlag,
    hostname,
  });
  if (!enabled) return null;

  const environment = telemetryEnvironment(options.productionReportingEnabled);

  const faro = initializeFaro({
    url: "/telemetry/collect",
    app: {
      name: "demos-authoring",
      version: options.release,
      environment,
    },
    sessionTracking: { enabled: false },
    instrumentations: [new ErrorsInstrumentation(), new WebVitalsInstrumentation()],
    beforeSend,
  });

  // §3/§6: `session.id` = the page-load id, on every item. A `metas.add`
  // getter, not a per-call field, so it also covers `reportUncaughtError`'s
  // direct `faro.api.pushError` call below and anything Faro's own
  // instrumentations push without going through this facade at all.
  faro.metas.add(() => ({ session: { id: options.pageLoadId } }));

  faroInstance = faro;
  const impl = buildFacade(faro, options.pageLoadId);

  // Z-D-H1 e2e-only hook — same dead-code-elimination guarantee as
  // `sentry.ts`'s `localTestSentryEnabled()` hooks (`__t06SentryCapture`/
  // `__t06ReportDemoEvent`) and `main.tsx`'s CrashProbe: gated on the exact
  // same build-time+host pair (`VITE_TELEMETRY_LOCAL === "1"`, a literal
  // Vite replaces at build time, so a plain production build folds this
  // whole branch — including the string literal below — to dead code;
  // `scripts/check-telemetry-leak.mjs`'s SENTINELS list covers
  // `__t06Telemetry` too, the durable proof it never survives a build
  // without the flag). `e2e/telemetry-faro.spec.ts` calls `event`/`metric`
  // directly through it to prove the H1 fix (two identical repeat pushes
  // are NOT collapsed by the facade) without having to drive the real
  // save/download UI just to fire two identical `example.saved` events.
  if (localFlag === "1" && typeof window !== "undefined" && (hostname === "localhost" || hostname === "127.0.0.1")) {
    (window as unknown as { __t06Telemetry?: Pick<Telemetry, "event" | "metric"> }).__t06Telemetry = {
      event: impl.event,
      metric: impl.metric,
    };
  }

  return impl;
}

/**
 * A render crash caught by `Sentry.ErrorBoundary`'s `onError` (ADR §E.2: "also
 * calls the facade, so render crashes reach Faro") — deliberately NOT routed
 * through the `Telemetry.error()` on the facade above, because that method is
 * contractually handled-only (`context.handled = "true"`, §6). A render crash
 * is the opposite: React caught it, so it never reaches `window.onerror` on
 * its own (Faro's `ErrorsInstrumentation` would otherwise never see it at
 * all), but it is still classified `error.uncaught` at ingest, same as a
 * global-handler catch. No-ops when Faro never initialised.
 */
export function reportUncaughtError(err: unknown): void {
  if (!faroInstance) return;
  const error = err instanceof Error ? err : new Error(String(err));
  faroInstance.api.pushError(error, { context: { context: "render-crash" } });
}
