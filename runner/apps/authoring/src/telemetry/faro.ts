// Faro init + the contract §6 `Telemetry` facade backed by it (ADR §E.4).
// Not import-free — pulls in `@grafana/faro-web-sdk`, so no test imports
// this file directly.
//
// Errors + web-vitals instrumentations only (ADR §E.4); session tracking
// off (the facade sets `session.id` itself via `metas.add`); no tracing.
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
 * Contract §6: `beforeSend` runs `scrubTelemetry` then the shared noise
 * gates, so Faro drops the same browser noise Sentry always has. Those
 * gates are Sentry-shaped (`{ exception: { values: [...] } }`); a Faro
 * `ExceptionEvent` is a single flat shape, so it's adapted here rather
 * than duplicated. `context.handled` mirrors Sentry's
 * `mechanism.handled`: only `buildFacade().error()` sets `"true"`.
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

/** Every item passes through the contract scrubber (ADR §E.4) before an
 *  `exception` item runs through the shared noise gates, AFTER scrubbing.
 *  BEFORE scrubbing, stack frames are run through `withoutMessageEchoFrames`
 *  on the RAW message — `scrubTelemetry` strips the URL query/fragment,
 *  which would break the substring match against Faro's fake
 *  message-echo frame (see `eventGate.ts`) before Gate 0b sees it. */
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

/** `scrub.ts#allowlistAttributes` drops any `HotAttrs` key with no dotted
 *  mapping here — six map 1:1 to `hot.*` resource attrs/Loki labels; the
 *  rest map to AE-only `hot.*` columns, never a resource attr or Loki label
 *  (`attrs.ts#AE_ONLY_ATTRIBUTE_KEYS`). */
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

/** Stringify a `HotAttrs` bag for Faro's `Record<string, string>` context,
 *  dropping `undefined` fields and remapping the six keys above to their
 *  dotted equivalent. `String(...)` is defensive, not a real conversion —
 *  every field is already a string at the type level. Parameter typed as
 *  `object`, not `Record<string,string|undefined>`: `HotAttrs` has no
 *  index signature, and TS requires a source type to declare one too. */
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
    // `skipDedupe: true` on both calls: faro-core's default GLOBAL dedupe
    // keeps exactly one `lastPayload` per API and skips a push that
    // deep-equals the previous one, with no time window — two identical
    // `example.saved`/`example.open` calls back-to-back would otherwise
    // silently drop the second before it leaves the browser. Server-side
    // redelivery hashing already includes the client timestamp, so this
    // client-side collapse buys no dedupe value here, only data loss.
    metric(name: MetricName, values: MetricValues, attrs: HotAttrs) {
      faro.api.pushMeasurement(
        { type: name, values: { ...values } as unknown as Record<string, number> },
        { context: attrsToContext(attrs), skipDedupe: true },
      );
    },
    event(name: EventName, attrs: HotAttrs & Record<string, string>) {
      faro.api.pushEvent(name, attrsToContext(attrs), undefined, { skipDedupe: true });
    },
    // A HANDLED error only (contract §6) — tagged `context.handled =
    // "true"` so the o11y worker's ingest-time split files it as
    // `error.handled`. An uncaught render crash goes through
    // `reportUncaughtError` below instead (not part of `Telemetry`).
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
   *  production/automation gate Sentry uses. */
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

  // §3/§6: `session.id` = the page-load id, on every item, via a
  // `metas.add` getter so it also covers `reportUncaughtError`'s direct
  // `pushError` call and Faro's own instrumentation pushes.
  faro.metas.add(() => ({ session: { id: options.pageLoadId } }));

  faroInstance = faro;
  const impl = buildFacade(faro, options.pageLoadId);

  // An e2e-only hook, same dead-code-elimination guarantee as
  // `sentry.ts`'s local-test hooks and `main.tsx`'s CrashProbe: gated on
  // `VITE_TELEMETRY_LOCAL === "1"` + localhost, a literal Vite folds away
  // in production (`check:telemetry-leak` greps `__t06Telemetry` as
  // proof). `e2e/telemetry-faro.spec.ts` calls `event`/`metric` directly
  // to prove two identical repeat pushes are NOT collapsed.
  if (localFlag === "1" && typeof window !== "undefined" && (hostname === "localhost" || hostname === "127.0.0.1")) {
    (window as unknown as { __t06Telemetry?: Pick<Telemetry, "event" | "metric"> }).__t06Telemetry = {
      event: impl.event,
      metric: impl.metric,
    };
  }

  return impl;
}

/**
 * A render crash caught by `Sentry.ErrorBoundary` (ADR §E.2) — not routed
 * through the facade's `Telemetry.error()`, which is contractually
 * handled-only (§6). React catches this before `window.onerror` sees it,
 * but it's still classified `error.uncaught` at ingest. No-op when Faro
 * never initialised.
 */
export function reportUncaughtError(err: unknown): void {
  if (!faroInstance) return;
  const error = err instanceof Error ? err : new Error(String(err));
  faroInstance.api.pushError(error, { context: { context: "render-crash" } });
}
