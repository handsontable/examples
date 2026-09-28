// The edit-burst collapse in front of the facade's demo-runtime reports.
//
// The Tier-1 preview re-runs on every keystroke, so typing ONE throwing
// line would otherwise relay a whole keystroke-prefix ladder as separate
// `preview.runtime_error` points. Rule: only the last run before the
// editor goes quiet counts.
//
// An edit (`noteEdit`) opens/extends a burst and discards everything the
// preview reported since the previous edit. Reports are held one per key
// (the §7 fingerprint) while the burst is open; `settleMs` after the LAST
// edit, the burst closes and the final run's reports emit once each.
// Outside a burst, a report emits immediately. A compile failure
// (`replacesRun`) drops whatever the burst holds and suppresses later
// non-compile reports, so a typed syntax error counts as one
// `sandpack.compile_error` and no `preview.runtime_error`.
//
// Import-free, clock/timer injected, same reason as `demoEventReport.ts`:
// `node --test` can pin this logic with nothing to import.

/** How long the editor must stay quiet before a burst closes. Longer than a
 *  mid-line pause while typing, short enough that the point still lands in
 *  the same dashboard interval as the edit. */
export const DEMO_EDIT_SETTLE_MS = 2000;

/** Hard ceiling on emitted reports per collapse instance. Bounds a demo
 *  that posts crafted, ever-different payloads with no edit in between. */
export const DEMO_COLLAPSE_CEILING = 50;

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
  pendingMax?: number;
}

export interface ReportOptions {
  replacesRun?: boolean;
}

export interface DemoEventCollapse<T> {
  /** An edit that re-runs the preview (a keystroke, a chat or Style-panel
   *  write, a file add/delete/rename). Opens or extends the burst. */
  noteEdit(): void;
  /** A report from the preview, keyed by fingerprint. `replacesRun` marks a
   *  compile failure of the newest edit (see the header): during a burst it
   *  replaces everything held and suppresses the burst's later non-compile
   *  reports; outside a burst it is emitted at once like any other report. */
  report(key: string, item: T, opts?: ReportOptions): void;
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
  const pendingMax = opts.pendingMax ?? DEMO_COLLAPSE_PENDING_MAX;
  /** Keys already emitted since the last edit/reset. */
  const counted = new Set<string>();
  /** The current run's held-back reports, first one per key. */
  let pending = new Map<string, T>();
  let timer: unknown = null;
  let used = 0;
  /** The open burst's newest edit failed to compile: its reports are from
   *  code already typed past, until the next edit. */
  let runReplaced = false;

  // No `counted` check here: `report` does it for the direct path, and a held
  // key cannot already be counted — `counted` is cleared when the burst opens
  // and nothing is emitted until it closes.
  function emit(key: string, item: T): void {
    if (used >= ceiling) return;
    counted.add(key);
    used += 1;
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
    for (const [key, item] of settled) emit(key, item);
  }

  return {
    noteEdit() {
      // The run these reports came from has been typed past.
      pending = new Map();
      counted.clear();
      runReplaced = false;
      if (timer !== null) opts.clearTimer(timer);
      timer = opts.setTimer(() => {
        timer = null;
        flush();
      }, settleMs);
    },
    report(key, item, reportOpts) {
      if (counted.has(key)) return;
      if (timer === null) {
        emit(key, item);
        return;
      }
      if (reportOpts?.replacesRun) {
        pending = new Map([[key, item]]);
        runReplaced = true;
        return;
      }
      if (runReplaced) return;
      if (pending.has(key) || pending.size >= pendingMax) return;
      pending.set(key, item);
    },
    flush,
    reset() {
      flush();
      counted.clear();
    },
  };
}
