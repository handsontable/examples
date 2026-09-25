// F26: the edit-burst collapse in front of the facade's demo-runtime reports.
//
// The Tier-1 preview re-runs on every keystroke, so typing ONE throwing line
// relays the whole keystroke-prefix ladder: `s is not defined`, `se is not
// defined`, …, a run of half-typed syntax errors, and only then the error the
// finished line actually throws. Before this module each rung became its own
// `preview.runtime_error` point (a 30-minute traffic run: 415 points for 10
// edits), so the metric counted typing speed, not broken demos.
//
// The rule: **only the last run before the editor goes quiet counts.**
//
// - An edit (`noteEdit`) opens or extends a burst. Everything the preview
//   reported since the previous edit belongs to a run the user has already
//   typed past, so it is discarded — that is what removes the ladder.
// - While a burst is open, reports are held back, one per key (the caller
//   passes the §7 fingerprint, so a fault seen through two channels — an
//   uncaught throw and React's console echo of it — is still one).
// - `settleMs` after the LAST edit the burst closes and whatever the final run
//   reported is emitted, once per key.
// - Outside a burst (a preview's first load, a click that throws, a Tier-2
//   rebuild whose errors land after the burst closed) a report is emitted
//   immediately.
// - A key emitted once is not emitted again until the next edit or `reset` —
//   "counted exactly once per edit burst", and a button that throws on every
//   click counts once between edits, not once per click.
//
// Why not the Sentry side's ladder handling: there is none at the count
// level. Sentry collapses the ladder into one ISSUE (`normalizeMonitorMessage`
// rule 1, DEV-2853) but still receives one EVENT per rung, capped only by the
// page-load `MONITOR_EVENT_CEILING` budget — which is exactly where the "20
// points per typed line" came from. And fingerprint-only dedupe cannot remove
// the ladder either: one typed line walks through several distinct shapes
// (`<ident> is not defined`, `Unexpected token`, `Unterminated string…`, the
// final throw), each a different fingerprint.
//
// Known imprecision, bounded: a report from a superseded run that is still in
// flight when the last keystroke lands (compile slower than the typist) is
// held with the final run's reports, since nothing on the relay says which
// run a report came from. That costs at most the one or two runs in flight at
// the last keystroke — a small constant per burst, not one point per rung.
//
// Import-free, and every clock/timer injected, for the same reason as
// `demoEventReport.ts`: `sentry.ts` imports `@sentry/react`, so `node --test`
// can only pin this logic from a module that imports nothing
// (`pipeline/demo-event-collapse.test.mjs`).

/** How long the editor must stay quiet before a burst closes. Longer than a
 *  mid-line pause while typing, short enough that the point still lands in
 *  the same dashboard interval as the edit. */
export const DEMO_EDIT_SETTLE_MS = 2000;

/** Hard ceiling on emitted reports per collapse instance (one per page load).
 *  The collapse bounds honest typing; this bounds a demo that posts crafted,
 *  ever-different payloads at the parent with no edit in between (the same
 *  threat `createMonitorBudget`'s doc comment describes). */
export const DEMO_COLLAPSE_CEILING = 50;

/** Distinct keys held for one burst. Anything past this is dropped — the
 *  final run of a real demo has a handful of distinct faults, not dozens. */
export const DEMO_COLLAPSE_PENDING_MAX = 20;

export interface DemoEventCollapseOptions<T> {
  /** Receives each report that survives the collapse. */
  emit: (item: T) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  settleMs?: number;
  ceiling?: number;
  pendingMax?: number;
}

export interface DemoEventCollapse<T> {
  /** An edit that re-runs the preview (a keystroke, a chat or Style-panel
   *  write, a file add/delete/rename). Opens or extends the burst. */
  noteEdit(): void;
  /** A report from the preview, keyed by fingerprint. */
  report(key: string, item: T): void;
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
    for (const [key, item] of settled) emit(key, item);
  }

  return {
    noteEdit() {
      // The run these reports came from has been typed past.
      pending = new Map();
      counted.clear();
      if (timer !== null) opts.clearTimer(timer);
      timer = opts.setTimer(() => {
        timer = null;
        flush();
      }, settleMs);
    },
    report(key, item) {
      if (counted.has(key)) return;
      if (timer === null) {
        emit(key, item);
        return;
      }
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
