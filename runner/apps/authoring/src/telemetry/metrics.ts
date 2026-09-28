// Observability contract §5 browser metric catalogue (ADR-0041 §F.2).
//
// Every emission function takes an INJECTED `Telemetry` parameter (not
// imported directly) so `App.tsx` can pass its live, reassignable binding.
// Erasable TS only: `pipeline/browser-metrics.test.mjs` imports this file
// directly under `node --experimental-strip-types`.

import type { DemoRuntime, SandpackCompileErrorEvent, SandpackCompileTimingEvent } from "@handsontable/demo-runtime";
import { isNextPrereleaseVersion, selectedReleaseMajor } from "@handsontable/demo-runtime";
import { fingerprint } from "@handsontable/demo-runtime/telemetry";
import { HT_MAJORS, type HotAttrs, type HtMajor, type Surface, type Telemetry } from "@handsontable/demo-runtime/telemetry";

// ---- ht_major -------------------------------------------------------------------

/**
 * Contract §3 `hot.ht_major` from a Handsontable version ref.
 *
 * A pkg.pr.new build ref maps to `"next"`, same as an actual `next`
 * prerelease. `HT_MAJORS` (the closed set `toAePoint` enforces) has no slot for a
 * build id, and both channels are equally "not a stable release" from a metrics
 * point of view — inventing a value outside the closed set would throw inside
 * `toAePoint` the first time anyone opened a demo pinned to a PR build.
 */
export function htMajorOf(ref: string | null | undefined): HtMajor {
  if (!ref) return "none";
  if (isNextPrereleaseVersion(ref)) return "next";
  const major = selectedReleaseMajor(ref);
  if (major === null) return "next"; // pkg.pr.new build ref, or unparsed
  const asString = String(major);
  return (HT_MAJORS as readonly string[]).includes(asString) ? (asString as HtMajor) : "none";
}

// ---- preview.ready_ms -------------------------------------------------------------

export interface PreviewResolveContext {
  surface: Surface;
  /** Derived from `entry.engine === "container" ? 2 : 1` (App.tsx), never
   *  from catalog `entry.tier` — the two disagree for UI-library starters,
   *  which would otherwise get the wrong ready-timeout bucket. */
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
   * Observe the SAME promise the caller already awaits from `mount()` —
   * never call `mount()` again. Required because both engines can reject
   * `mount()` without ever calling `onError` (DEV-2130); a tracker that
   * only listened to ready/error would record those as `abandoned`
   * instead of `error`.
   */
  observe(mountPromise: Promise<unknown>): void;
  /** The caller is switching away before this preview settled (a version switch,
   *  an example switch, an unmount). No-op once ready/error/timeout already fired. */
  abandon(): void;
}

/** Generous, tier-specific defaults: Tier-2 cold boots can take minutes
 *  (install + start after the create POST); Tier-1's hosted bundler has no
 *  such step. Neither number is measured against production traffic yet. */
const DEFAULT_PREVIEW_TIMEOUT_MS: Record<1 | 2, number> = {
  1: 30_000,
  2: 180_000,
};

/**
 * §5 `preview.ready_ms`, from resolve to `data-preview-status = ready`.
 * Call at resolve time (before `mount()`), pass `mountPromise` to
 * `observe()`, call `abandon()` from the effect's cleanup.
 *
 * Emits exactly once: the first of `onReady`, an observed rejection, the
 * timeout, or `abandon()` wins; every later signal (including a second
 * `onReady` on a clean Sandpack recompile) is a no-op.
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

// ---- sandpack.compile_ms/compile_error/bundler_unreachable, session.start_ms, hmr.roundtrip_ms --

/** Quiet time after a compile before its held `sandpack.compile_ms` is sent;
 *  the same settle window as the edit-burst collapse (`DEMO_EDIT_SETTLE_MS`). */
export const COMPILE_TIMING_SETTLE_MS = 2000;

/** Senders of every runtime's held point, for the page-hide flush. */
const heldCompileTimings = new Set<() => void>();

/** Sends every held `sandpack.compile_ms` now. */
export function flushCompileTimings(): void {
  for (const send of [...heldCompileTimings]) send();
}

if (typeof window !== "undefined") {
  // Capture phase at `window` runs before Faro's own hidden-flush listener on `document`.
  window.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") flushCompileTimings();
    },
    true,
  );
}

export interface WireRuntimeMetricsOptions {
  collapseCompileError?: (emit: () => void, origin: SandpackCompileErrorEvent["origin"]) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Wires whichever §5 timing hooks `runtime` implements to their contract
 * points, through optional chains (`runtime.onX?.(cb)`) so no engine
 * branch is needed at the call site.
 *
 * `sandpack.compile_ms`: the first compile (the mount) is sent at once; after
 * it, each compile replaces the held one and the last of a burst is sent once
 * no compile or compile error follows for `COMPILE_TIMING_SETTLE_MS` (§5).
 *
 * A compile error is deduped by fingerprint for the life of `runtime`,
 * unless `opts.collapseCompileError` (the edit-burst collapse) is given,
 * in which case it counts once per burst instead. `session.start_ms`'s
 * `reason` (cold/warm) is intentionally never set — no client-observable
 * signal exists to attach it from.
 */
export function wireRuntimeMetrics(
  runtime: DemoRuntime,
  ctx: { framework: string; versionRef: string },
  telemetry: Telemetry,
  opts: WireRuntimeMetricsOptions = {},
): void {
  const htMajor = htMajorOf(ctx.versionRef);
  const seenFingerprints = new Set<string>();
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const sendCompileTiming = (event: SandpackCompileTimingEvent) =>
    telemetry.metric(
      "sandpack.compile_ms",
      { duration_ms: event.durationMs },
      { tier: "1", framework: ctx.framework, ht_major: htMajor, outcome: event.outcome },
    );
  let mountCompileSent = false;
  let held: { event: SandpackCompileTimingEvent; timer: unknown } | null = null;
  const sendHeld = () => {
    heldCompileTimings.delete(sendHeld);
    if (!held) return;
    clearTimer(held.timer);
    const { event } = held;
    held = null;
    sendCompileTiming(event);
  };

  runtime.onCompileTiming?.((event) => {
    if (!mountCompileSent) {
      mountCompileSent = true;
      sendCompileTiming(event);
      return;
    }
    if (held) clearTimer(held.timer);
    held = { event, timer: setTimer(sendHeld, COMPILE_TIMING_SETTLE_MS) };
    heldCompileTimings.add(sendHeld);
  });

  runtime.onCompileError?.((event) => {
    // A keystroke that fails the pre-transpile dispatches no compile, but it is still part of the burst.
    if (held) {
      clearTimer(held.timer);
      held.timer = setTimer(sendHeld, COMPILE_TIMING_SETTLE_MS);
    }
    const fp = fingerprint("sandpack.compile_error", event.message);
    const emit = () =>
      telemetry.metric(
        "sandpack.compile_error",
        {},
        { framework: ctx.framework, ht_major: htMajor, fingerprint: fp },
      );
    if (opts.collapseCompileError) {
      opts.collapseCompileError(emit, event.origin);
      return;
    }
    if (seenFingerprints.has(fp)) return;
    seenFingerprints.add(fp);
    emit();
  });

  runtime.onBundlerUnreachable?.((event) => {
    telemetry.metric(
      "sandpack.bundler_unreachable",
      { duration_ms: event.durationMs },
      { ht_major: htMajor },
    );
  });

  runtime.onSessionStart?.((event) => {
    telemetry.metric(
      "session.start_ms",
      { duration_ms: event.elapsedMs },
      { framework: ctx.framework, ht_major: htMajor, outcome: event.outcome },
    );
  });

  runtime.onHmr?.((event) => {
    telemetry.metric(
      "hmr.roundtrip_ms",
      { duration_ms: event.durationMs },
      { framework: ctx.framework, ht_major: htMajor },
    );
  });
}

// ---- version.switch / bucket.resolve_ms ------------------------------------------

/** §5 `version.switch` — call before the remount effect tears down the old
 *  preview. `reason` carries the FROM version's `ht_major`, not the raw ref
 *  (which traces back to the user-controlled `?v=` param). */
export function emitVersionSwitch(
  telemetry: Telemetry,
  params: { framework: string; toRef: string; fromRef?: string | null; bucket?: string },
): void {
  const attrs: HotAttrs = {
    framework: params.framework,
    ht_major: htMajorOf(params.toRef),
    reason: htMajorOf(params.fromRef),
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
