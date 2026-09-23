// Observability contract §5 browser metric catalogue (T07 — runner/tasks/o11y/T07-browser-metrics.md).
//
// PHASE 1 (current): every emission function here takes an INJECTED `Telemetry`
// (the contract §6 interface) as a parameter. This file does not import
// `apps/authoring/src/telemetry/index.ts` — that is T06's facade, not created by
// this task in Phase 1 (COMMON.md: T06 owns App.tsx's reporting regions and lands
// first). Phase 2 wires these functions to T06's real `telemetry` export at each
// call site in App.tsx once T06 is merged.
//
// The runtime engines (`packages/runtime/src/sandpack.ts`, `container.ts`) expose
// timing through engine-specific callbacks — `onCompileTiming`/`onCompileError`/
// `onBundlerUnreachable` on `SandpackRuntime`, `onSessionStart`/`onHmr` on
// `ContainerRuntime` — in the same style as the existing `onProgress`/`onStderr`
// extension points, not on the shared `DemoRuntime` interface. Neither runtime
// file imports `@handsontable/demo-runtime/telemetry`; this module is where the
// hook payloads become `toAePoint`-shaped metric calls.
//
// Erasable TS only (interfaces, type aliases, plain functions/classes — no enums,
// no parameter properties): `pipeline/browser-metrics.test.mjs` imports this file
// directly under `node --experimental-strip-types`, the same way
// `pipeline/drop-files.test.mjs` imports `packages/editor-shell/src/dropFiles.ts`.
// Every value-level import must be real ESM the Node loader can resolve at test
// time too — `@handsontable/demo-runtime/telemetry`'s `fingerprint` resolves
// through the workspace symlink to `packages/runtime/dist/telemetry/index.js`
// (built by `pnpm test`'s own build step), same as every other package import
// here. `DemoRuntime`/`SandpackRuntime`/`ContainerRuntime` and their event types
// are imported `type`-only, so they are erased entirely and never need runtime
// resolution.

import type { DemoRuntime } from "@handsontable/demo-runtime";
import { isNextPrereleaseVersion, selectedReleaseMajor } from "@handsontable/demo-runtime";
import type {
  SandpackBundlerUnreachableEvent,
  SandpackCompileErrorEvent,
  SandpackCompileTimingEvent,
  SandpackRuntime,
} from "@handsontable/demo-runtime/sandpack";
import type {
  ContainerRuntime,
  HmrRoundtripEvent,
  SessionStartTimingEvent,
} from "@handsontable/demo-runtime/container";
import { fingerprint } from "@handsontable/demo-runtime/telemetry";
import { HT_MAJORS, type HotAttrs, type HtMajor, type Surface, type Telemetry } from "@handsontable/demo-runtime/telemetry";

// ---- ht_major -------------------------------------------------------------------

/**
 * Contract §3 `hot.ht_major` from a Handsontable version ref.
 *
 * T07-D1: a pkg.pr.new build ref maps to `"next"`, same as an actual `next`
 * prerelease. `HT_MAJORS` (the closed set `toAePoint` enforces) has no slot for a
 * build id, and both channels are equally "not a stable release" from a metrics
 * point of view — inventing a value outside the closed set would throw inside
 * `toAePoint` the first time anyone opened a demo pinned to a PR build.
 */
export function htMajorOf(ref: string | null | undefined): HtMajor {
  if (!ref) return "none";
  if (isNextPrereleaseVersion(ref)) return "next";
  const major = selectedReleaseMajor(ref);
  if (major === null) return "next"; // pkg.pr.new build ref (T07-D1), or unparsed
  const asString = String(major);
  return (HT_MAJORS as readonly string[]).includes(asString) ? (asString as HtMajor) : "none";
}

// ---- preview.ready_ms -------------------------------------------------------------

export interface PreviewResolveContext {
  surface: Surface;
  tier: 1 | 2;
  framework: string;
  /** The version ref the preview is being resolved against — converted to the
   *  closed `ht_major` set internally, so callers pass the raw ref they already
   *  have (`HandsontableVersionRef.ref` / `v.value.ref` in App.tsx). */
  versionRef: string;
  bucket?: string;
}

export type PreviewReadyOutcome = "ready" | "error" | "timeout" | "abandoned";

export interface PreviewReadyTracker {
  /**
   * Observe the SAME promise the caller already awaits from `runtime.mount(...)`
   * — never call `mount()` a second time. Required because both engines can
   * reject `mount()` without ever calling `onError`: `ContainerRuntime.mount`'s
   * catch calls `this.dispose()` (which clears `errorCbs`) before rethrowing, and
   * `SandpackRuntime.mount`'s `buildSetup`/`loadSandpackClient` rejections
   * (DEV-2130 "Setup failed") go straight to the caller's `.catch()` with no
   * `onError` call at all. A tracker that only listened to the ready/error
   * callbacks would record exactly these — the most common Tier-2 failures
   * (`at_capacity`, budget refusals, an edge 403) — as `abandoned` once the
   * caller's effect cleanup ran, instead of `error`.
   */
  observe(mountPromise: Promise<unknown>): void;
  /** The caller is switching away before this preview settled (a version switch,
   *  an example switch, an unmount). No-op once ready/error/timeout already fired. */
  abandon(): void;
}

/** Generous, tier-specific defaults (T07-D2): Tier-2 cold boots can take minutes
 *  (the create POST alone can sit near Cloudflare's ~100s edge ceiling, and the
 *  dev server still has to install and start after that), so a short timeout here
 *  would latch `timeout` and then silently drop the real `ready` that follows.
 *  Tier-1's hosted bundler has no comparable install step. Neither number is
 *  measured against production traffic yet — both are a ceiling picked to never
 *  fire before a real failure would already have reported through `onError`, not
 *  a target latency. Revisit once T09 has real `preview.ready_ms` data per tier. */
const DEFAULT_PREVIEW_TIMEOUT_MS: Record<1 | 2, number> = {
  1: 30_000,
  2: 180_000,
};

/**
 * §5 `preview.ready_ms` — "from the moment an example is resolved to
 * `data-preview-status = ready`". Call this at the moment of resolve (immediately
 * after constructing the runtime, before `mount()`), pass `mountPromise` to
 * `observe()`, and call `abandon()` from the same effect's cleanup.
 *
 * Emits exactly once per tracker instance: the first of `onReady`, an observed
 * rejection, the timeout, or `abandon()` wins, and every later signal is a no-op —
 * including a SECOND `onReady` call, which `SandpackRuntime` fires on every clean
 * recompile, not just the first (so an edit made after the preview is already
 * ready must never re-emit `preview.ready_ms`).
 */
export function trackPreviewReady(
  runtime: DemoRuntime,
  ctx: PreviewResolveContext,
  telemetry: Telemetry,
  opts: { timeoutMs?: number; now?: () => number } = {},
): PreviewReadyTracker {
  const now = opts.now ?? (() => performance.now());
  const startedAt = now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS[ctx.tier];
  const htMajor = htMajorOf(ctx.versionRef);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (outcome: PreviewReadyOutcome) => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    const attrs: HotAttrs = {
      surface: ctx.surface,
      tier: String(ctx.tier) as HotAttrs["tier"],
      framework: ctx.framework,
      ht_major: htMajor,
      outcome,
    };
    if (ctx.bucket !== undefined) attrs.bucket = ctx.bucket;
    telemetry.metric("preview.ready_ms", { duration_ms: Math.round(now() - startedAt) }, attrs);
  };

  runtime.onReady(() => finish("ready"));
  runtime.onError(() => finish("error"));
  timer = setTimeout(() => finish("timeout"), timeoutMs);

  return {
    observe(mountPromise) {
      mountPromise.catch(() => finish("error"));
    },
    abandon() {
      finish("abandoned");
    },
  };
}

// ---- sandpack.compile_ms / compile_error / bundler_unreachable --------------------

/**
 * Wire a `SandpackRuntime`'s compile timing hooks to §5's Tier-1 compile metrics.
 * `sandpack.compile_error` is deduped by fingerprint for the life of `runtime` — a
 * babel error the visitor has not fixed yet re-fires on every keystroke that still
 * fails to parse (`pushUpdate`'s own transpile-failure path never even reaches the
 * bundler for those), and without a dedupe this would turn one authored typo into
 * one point per keystroke instead of one point per distinct diagnostic.
 */
export function wireSandpackMetrics(
  runtime: SandpackRuntime,
  ctx: { framework: string; versionRef: string },
  telemetry: Telemetry,
): void {
  const htMajor = htMajorOf(ctx.versionRef);
  const seenFingerprints = new Set<string>();

  runtime.onCompileTiming((event: SandpackCompileTimingEvent) => {
    telemetry.metric(
      "sandpack.compile_ms",
      { duration_ms: event.durationMs },
      { tier: "1", framework: ctx.framework, ht_major: htMajor, outcome: event.outcome },
    );
  });

  runtime.onCompileError((event: SandpackCompileErrorEvent) => {
    const fp = fingerprint("sandpack.compile_error", event.message);
    if (seenFingerprints.has(fp)) return;
    seenFingerprints.add(fp);
    telemetry.metric(
      "sandpack.compile_error",
      {},
      { framework: ctx.framework, ht_major: htMajor, fingerprint: fp },
    );
  });

  runtime.onBundlerUnreachable((event: SandpackBundlerUnreachableEvent) => {
    telemetry.metric(
      "sandpack.bundler_unreachable",
      { duration_ms: event.durationMs },
      { ht_major: htMajor },
    );
  });
}

// ---- session.start_ms / hmr.roundtrip_ms -----------------------------------------

/**
 * Wire a `ContainerRuntime`'s session-start and HMR timing hooks to §5's Tier-2
 * metrics.
 *
 * T07-D2 — `session.start_ms`'s `reason` (cold/warm) is intentionally never set.
 * `toAePoint` accepts the metric with `reason` omitted (every `HotAttrs` field is
 * optional; the closed-set check in `metrics.ts#toAePoint` only fires when a value
 * IS supplied), so this is a valid point, just without that breakdown. No
 * client-observable cold/warm signal exists anywhere in the codebase today
 * (`sessionDiagnostics.ts` — the "existing session diagnostics" this task's Scope
 * names — only classifies elapsed time and response origin) — the create response
 * (`{ previewUrl, port }`) carries nothing about pool state, and each mount mints a
 * fresh session id, so there is no "was this container already warm" fact
 * available client-side to attach. Following through on a latency-threshold guess
 * would put a fabricated split on a dashboard as if it were measured. Follow-up:
 * T05/the API worker should add a `cold`/`warm` field to the create response
 * (it already knows this — the pool it drew from is server state).
 */
export function wireContainerMetrics(
  runtime: ContainerRuntime,
  ctx: { framework: string; versionRef: string },
  telemetry: Telemetry,
): void {
  const htMajor = htMajorOf(ctx.versionRef);

  runtime.onSessionStart((event: SessionStartTimingEvent) => {
    telemetry.metric(
      "session.start_ms",
      { duration_ms: event.elapsedMs },
      { framework: ctx.framework, ht_major: htMajor, outcome: event.outcome },
    );
  });

  runtime.onHmr((event: HmrRoundtripEvent) => {
    telemetry.metric(
      "hmr.roundtrip_ms",
      { duration_ms: event.durationMs },
      { framework: ctx.framework, ht_major: htMajor },
    );
  });
}

// ---- version.switch / bucket.resolve_ms ------------------------------------------

/** §5 `version.switch` — call from the version-picker change handler, before the
 *  remount effect tears down the old preview. `reason` carries the FROM version as
 *  a free-form label (the metric's §5 row has no closed set for it — only `ht_major`,
 *  the TO version, is enumerable); `null`/absent reads as `"none"`, matching the
 *  `ht_major` convention for "no version attached". */
export function emitVersionSwitch(
  telemetry: Telemetry,
  params: { framework: string; toRef: string; fromRef?: string | null; bucket?: string },
): void {
  const attrs: HotAttrs = {
    framework: params.framework,
    ht_major: htMajorOf(params.toRef),
    reason: params.fromRef ?? "none",
  };
  if (params.bucket !== undefined) attrs.bucket = params.bucket;
  telemetry.metric("version.switch", {}, attrs);
}

/** §5 `bucket.resolve_ms`. Pair with `startClock()` around the
 *  `resolveDocsBucket`/`resolveStarterBucket` call. */
export function emitBucketResolve(
  telemetry: Telemetry,
  params: { bucket: string; outcome: "ok" | "error"; durationMs: number },
): void {
  telemetry.metric(
    "bucket.resolve_ms",
    { duration_ms: params.durationMs },
    { bucket: params.bucket, outcome: params.outcome },
  );
}

/** A tiny stopwatch: `startClock()` now, call the returned function once the
 *  measured work finishes to get the elapsed milliseconds (rounded). Shared by
 *  every duration-metric call site so none of them hand-roll `performance.now()`
 *  subtraction. */
export function startClock(now: () => number = () => performance.now()): () => number {
  const startedAt = now();
  return () => Math.round(now() - startedAt);
}
