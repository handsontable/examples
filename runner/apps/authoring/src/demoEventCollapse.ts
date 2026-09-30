// The edit-burst collapse in front of the facade's demo-runtime reports: the
// Tier-1 preview re-runs on every keystroke, so only the last run before the
// editor goes quiet counts, one report per key (§7 fingerprint) per burst. A
// compile failure (`replacesRun`) replaces the run's reports; an unchanged
// push keeps the running sandbox's (contract §5). Import-free, timers
// injected, so `node --test` can pin this logic.

/** How long the editor must stay quiet before a burst closes. Longer than a
 *  mid-line pause while typing, short enough that the point still lands in
 *  the same dashboard interval as the edit. */
export const DEMO_EDIT_SETTLE_MS = 2000;

/** Hard ceiling on emitted reports per collapse instance. Bounds a demo
 *  that posts crafted, ever-different payloads with no edit in between. */
export const DEMO_COLLAPSE_CEILING = 50;

/** Ceiling for `compile:` keys, counted apart from runtime reports so a long
 *  edit session of runtime errors cannot silence compile errors (or the reverse). */
export const DEMO_COMPILE_CEILING = 50;

/** Distinct keys held for one burst. Anything past this is dropped — the
 *  final run of a real demo has a handful of distinct faults, not dozens. */
const DEMO_COLLAPSE_PENDING_MAX = 20;

export interface DemoEventCollapseOptions<T> {
  /** Receives each report that survives the collapse. */
  emit: (item: T) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  settleMs?: number;
  ceiling?: number;
  compileCeiling?: number;
  pendingMax?: number;
}

export interface ReportOptions {
  replacesRun?: boolean;
  /** With `replacesRun`: the bundler rejected the dispatched sandbox, so the
   *  error is that sandbox's result (a pre-transpile failure never ran). */
  fromBundler?: boolean;
}

/** What the newest edit's push did: dispatched a new sandbox (`rerun`), or
 *  found it identical to the running one and sent nothing (`unchanged`). */
export type PushOutcome = "rerun" | "unchanged";

export interface DemoEventCollapse<T> {
  /** An edit that re-runs the preview (a keystroke, a chat or Style-panel
   *  write, a file add/delete/rename). Opens or extends the burst. */
  noteEdit(): void;
  /** A report from the preview, keyed by fingerprint. `replacesRun` marks a
   *  compile failure of the newest edit (see the header): during a burst it
   *  replaces everything held and suppresses the burst's later non-compile
   *  reports; outside a burst it is emitted at once like any other report. */
  report(key: string, item: T, opts?: ReportOptions): void;
  /** The newest edit's push outcome (Tier 1 only). `rerun` (the bundler starts
   *  a new sandbox) drops what the burst held from the run it replaces;
   *  `unchanged` makes the burst's result the running sandbox's not-yet-emitted
   *  reports, since no new run will replace them. */
  pushOutcome(outcome: PushOutcome): void;
  /** Close the open burst now (emit what the last run reported). */
  flush(): void;
  /** A new preview mount: close the open burst for the outgoing preview,
   *  then forget which keys were already counted, so the next preview's
   *  first-load errors count again. The ceiling is NOT reset. */
  reset(): void;
}

export function createDemoEventCollapse<T>(opts: DemoEventCollapseOptions<T>): DemoEventCollapse<T> {
  const settleMs = opts.settleMs ?? DEMO_EDIT_SETTLE_MS;
  const ceiling = opts.ceiling ?? DEMO_COLLAPSE_CEILING;
  const compileCeiling = opts.compileCeiling ?? DEMO_COMPILE_CEILING;
  const pendingMax = opts.pendingMax ?? DEMO_COLLAPSE_PENDING_MAX;
  /** Keys already emitted since the last edit/reset. */
  const counted = new Set<string>();
  /** The current run's held-back reports, first one per key. */
  let pending = new Map<string, T>();
  let timer: unknown = null;
  let used = 0;
  let compileUsed = 0;
  /** The open burst's newest edit failed to compile: its reports are from
   *  code already typed past, until the next edit. */
  let runReplaced = false;
  /** The open burst's newest edit failed the pre-transpile, so no run of it will start. */
  let editFailed = false;
  /** Reports of the running sandbox (since the last `rerun` or `reset`),
   *  first one per key, with whether it has been emitted. */
  let running = new Map<string, { item: T; emitted: boolean }>();
  /** The running sandbox was rejected by the bundler: it never evaluated. */
  let runningReplaced = false;

  // No `counted` check here: `report` does it for the direct path, and a held
  // key cannot already be counted — `counted` is cleared when the burst opens
  // and nothing is emitted until it closes.
  function emit(key: string, item: T): void {
    const isCompile = key.startsWith("compile:");
    if (isCompile ? compileUsed >= compileCeiling : used >= ceiling) return;
    const current = running.get(key);
    if (current) current.emitted = true;
    counted.add(key);
    if (isCompile) compileUsed += 1;
    else used += 1;
    opts.emit(item);
  }

  function flush(): void {
    if (timer !== null) {
      opts.clearTimer(timer);
      timer = null;
    }
    const settled = pending;
    pending = new Map();
    runReplaced = false;
    editFailed = false;
    for (const [key, item] of settled) emit(key, item);
  }

  return {
    noteEdit() {
      // The run these reports came from has been typed past.
      pending = new Map();
      counted.clear();
      runReplaced = false;
      editFailed = false;
      if (timer !== null) opts.clearTimer(timer);
      timer = opts.setTimer(() => {
        timer = null;
        flush();
      }, settleMs);
    },
    report(key, item, reportOpts) {
      if (reportOpts?.replacesRun && reportOpts.fromBundler) {
        running = new Map([[key, { item, emitted: counted.has(key) }]]);
        runningReplaced = true;
      } else if (!reportOpts?.replacesRun && !runningReplaced && !running.has(key) && running.size < pendingMax) {
        running.set(key, { item, emitted: counted.has(key) });
      }
      if (counted.has(key)) return;
      if (timer === null) {
        emit(key, item);
        return;
      }
      if (reportOpts?.replacesRun) {
        pending = new Map([[key, item]]);
        runReplaced = true;
        editFailed = !reportOpts.fromBundler;
        return;
      }
      if (runReplaced) return;
      if (pending.has(key) || pending.size >= pendingMax) return;
      pending.set(key, item);
    },
    pushOutcome(outcome) {
      if (outcome === "rerun") {
        running = new Map();
        runningReplaced = false;
        // What the burst held came from the run this one replaces.
        if (!editFailed) {
          pending = new Map();
          runReplaced = false;
        }
        return;
      }
      if (timer === null) return;
      pending = new Map();
      for (const [key, { item, emitted }] of running) if (!emitted) pending.set(key, item);
      runReplaced = runningReplaced;
    },
    flush,
    reset() {
      flush();
      counted.clear();
      running = new Map();
      runningReplaced = false;
    },
  };
}
