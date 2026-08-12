// ContainerRuntime — Tier-2 engine. Implements the same DemoRuntime interface as
// SandpackRuntime, so the editor shell drives a Remix/Next/Astro/Nuxt/Angular
// demo exactly like a React one. Behind the interface it talks to the
// orchestration Worker: POST a session (files -> real dev server in a Cloudflare
// Sandbox container) and point the preview iframe at the container preview URL;
// stream edits as file writes that the dev server HMRs.
//
// DOM-only: imported via the "@handsontable/demo-runtime/container" subpath so it
// is never bundled into the (non-DOM) Worker itself.

import type {
  CatalogEntry,
  DemoRuntime,
  FilesMap,
  HandsontableVersionRef,
  WriteFileOptions,
} from "./types.js";
import { mintSessionId } from "./session.js";
import { applyHandsontableCss, applyHandsontableVersion } from "./version.js";

/** The container reached the server and booted, but the boot script itself
 * exited nonzero (e.g. pnpm couldn't resolve the pinned Handsontable
 * version) — as opposed to the session request never reaching the server at
 * all. Callers should show this message as-is: it's a real, often-multiline
 * install/boot log, not a connectivity problem, and its text can incidentally
 * contain words like "fetching" that would otherwise trip a generic
 * network-error heuristic. */
export class ContainerBootFailure extends Error {}

/** POST /api/session failed. `status` distinguishes the server's 410
 * "closed while being created" (session already destroyed server-side; a
 * follow-up DELETE would only re-extend its tombstone) from other failures.
 * `code` carries the server's machine-readable reason when it sent one —
 * `budget_exhausted` / `budget_login_required` are cost-guardrail refusals
 * (DEV-2030): a deliberate product state with a message written for users, not
 * a fault to retry or report. */
export class SessionStartError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** True for the guardrail refusals above — "the system said no on purpose". */
export const isBudgetRefusal = (e: unknown): e is SessionStartError =>
  e instanceof SessionStartError && typeof e.code === "string" && e.code.startsWith("budget_");

/** Read a `{ error, message }` body if the server sent one, else the raw text. */
async function readFailure(res: Response): Promise<{ code?: string; message: string }> {
  const text = await res.text().catch(() => res.statusText);
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    if (body?.error) return { code: body.error, message: body.message ?? body.error };
  } catch { /* not JSON — fall through to the raw text */ }
  return { message: text };
}

/** How long `reload()` waits for the reloaded page's `load` before settling anyway.
 *  Generous: a container that is merely slow should still resolve on the real event. */
const RELOAD_TIMEOUT_MS = 10_000;

/** Polling cadence and budget *after* the boot script has reported a nonzero exit.
 *  Slower than the boot cadence (2.5s) and bounded: the point is to notice a dev
 *  server that comes up in spite of the exit marker, not to keep probing a container
 *  that is never going to answer. 10s × 12 ≈ two minutes. */
const FAILED_POLL_INTERVAL_MS = 10_000;
const FAILED_POLLS_MAX = 12;

/** The live-session API accepts only relative POSIX paths. */
function relativeFiles(files: FilesMap): FilesMap {
  return Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [relativePath(path), contents]),
  );
}

function relativePath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

export interface ContainerRuntimeOptions {
  /** The shell's preview-iframe slot; its src is set to the container preview URL. */
  iframe: HTMLIFrameElement;
  /** Origin of the orchestration Worker (e.g. http://localhost:8787). */
  apiBase: string;
  /** Pin Handsontable to this version before starting the session. */
  version?: HandsontableVersionRef;
  /** Optional session id (else a fresh one is minted per mount). MUST be
   *  unique per create: the server tombstones a deleted id for 10 minutes and
   *  tears down any session recreated under it in that window. */
  sessionId?: string;
  /** Debounce for streamed edits (ms). */
  writeDebounceMs?: number;
  /** Grace after the preview iframe loads, for the SPA to render (ms). */
  renderGraceMs?: number;
  /** Keepalive ping interval to keep the container warm while open (ms). */
  keepaliveMs?: number;
  /** Broker token of the signed-in user, when there is one. Sent with the
   *  session request so the cost guardrail's `anon_blocked` tier (live editing
   *  restricted to signed-in users at >=80% of budget) can recognise them. */
  authToken?: string | null;
}

export class ContainerRuntime implements DemoRuntime {
  private readonly entry: CatalogEntry;
  private readonly opts: ContainerRuntimeOptions;
  private sessionId: string | null = null;
  // sessionId exists from the moment mount() starts (so a tab close can always
  // DELETE), but the session accepts writes only once the create POST has
  // succeeded — streaming an edit mid-create would race the create handler's
  // own writeFiles and could overwrite the newer edit with the boot snapshot.
  private mounted = false;
  private files: FilesMap = {};
  private readonly readyCbs = new Set<() => void>();
  private readonly errorCbs = new Set<(e: Error) => void>();
  private didReady = false;
  private disposed = false;
  private pending = new Map<string, string>();
  /** Writes deliberately kept out of the dev server for now — see `writeFile`'s
   *  `quiet` option. Drained by `flush()` together with `pending`, so they are never
   *  lost: only delayed until something is going over the wire anyway. */
  private quietPending = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly progressCbs = new Set<(log: string) => void>();
  private previewUrl = "";
  private port = 0;
  private pointed = false;
  /** Settle callbacks for in-flight `reload()` promises, so `dispose()` can close them
   *  out rather than leaving the shell's refresh spinner up on a torn-down preview. */
  private readonly reloadSettlers = new Set<() => void>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many failed-state polls have gone out since the boot script reported a nonzero
   *  exit. Kept because polling continues past that report (see `poll()`) and has to
   *  stop eventually — a dead dev server never comes back on its own, and each poll
   *  costs two `exec`s in the container. */
  private failedPolls = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Tear the session down when the page goes away (tab close, navigation) —
  // otherwise the container squats one of the few live-preview instance slots
  // until sleepAfter expires. pagehide is the reliable end-of-page signal
  // (fires on tab close and navigation; unload/beforeunload are skipped by
  // bfcache-eligible navigations and headless closes). A bfcache freeze
  // (persisted=true) is NOT the end of the page — the browser may restore it
  // via back/forward, and a disposed runtime would leave that restored page
  // with a dead preview. Keep the session; if the page never comes back, the
  // container's sleepAfter idle window reclaims the slot (keepalive pings are
  // frozen along with the page).
  private readonly onPagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) this.dispose();
  };

  constructor(entry: CatalogEntry, opts: ContainerRuntimeOptions) {
    if (entry.engine !== "container") {
      throw new Error(`ContainerRuntime requires engine 'container'; ${entry.framework} is '${entry.engine}'`);
    }
    this.entry = entry;
    this.opts = opts;
  }

  onReady(cb: () => void): void {
    this.readyCbs.add(cb);
    if (this.didReady) cb();
  }
  onError(cb: (e: Error) => void): void {
    this.errorCbs.add(cb);
  }
  /** Boot-progress log lines while the container installs deps + starts the dev server. */
  onProgress(cb: (log: string) => void): void {
    this.progressCbs.add(cb);
  }
  private emitReady() {
    if (this.didReady) return;
    this.didReady = true;
    for (const cb of this.readyCbs) cb();
  }
  private emitError(e: Error) {
    for (const cb of this.errorCbs) cb(e);
  }
  private emitProgress(log: string) {
    for (const cb of this.progressCbs) cb(log);
  }

  async mount(files: FilesMap): Promise<{ previewUrl: string }> {
    this.files = this.opts.version
      ? applyHandsontableCss(applyHandsontableVersion(files, this.opts.version), this.opts.version)
      : files;

    // Mint the session id client-side (mintSessionId is shared with the
    // Worker so both sides always produce the same shape) and register the
    // pagehide teardown BEFORE the session request: the server starts creating
    // the container while the POST is in flight (file writes alone boot it),
    // and a tab close during that window — at its widest when the instance
    // pool is full and the request is stuck waiting for a slot — must already
    // know an id to DELETE. With a server-minted id there is nothing to
    // delete yet.
    const sessionId = this.opts.sessionId?.trim() || mintSessionId(this.entry.framework);
    this.sessionId = sessionId;
    window.addEventListener("pagehide", this.onPagehide);

    let previewUrl: string;
    let port: number;
    try {
      const res = await fetch(`${this.opts.apiBase}/api/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.opts.authToken ? { Authorization: `Bearer ${this.opts.authToken}` } : {}),
        },
        body: JSON.stringify({
          framework: this.entry.framework,
          files: relativeFiles(this.files),
          sessionId,
          htVersion: this.opts.version?.ref,
        }),
      });
      if (!res.ok) {
        const failure = await readFailure(res);
        // A guardrail refusal already reads as a sentence aimed at the user;
        // wrapping it in "session start failed (503): …" would bury it (and
        // would trip the app's generic connectivity heuristic).
        throw new SessionStartError(
          res.status,
          failure.code?.startsWith("budget_")
            ? failure.message
            : `session start failed (${res.status}): ${failure.message}`,
          failure.code,
        );
      }
      ({ previewUrl, port } = (await res.json()) as { previewUrl: string; port: number });
    } catch (err) {
      // A failed create can still leave a half-created session server-side
      // (the POST handler's file writes boot the container before the step
      // that failed). Tear the runtime down and DELETE by the local id —
      // dispose() alone can't be trusted with it: a mid-flight dispose() may
      // already have nulled this.sessionId. Exception: on the server's 410
      // ("closed while being created") the session is already destroyed, and
      // another DELETE would only re-extend its tombstone TTL.
      this.sessionId = null;
      this.dispose();
      if (!(err instanceof SessionStartError && err.status === 410)) this.deleteSession(sessionId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.previewUrl = previewUrl;
    this.port = port;

    if (this.disposed) {
      // dispose() ran while the session request was in flight. Its DELETE
      // raced the server's container creation, so now that creation has
      // definitely finished, send another to tear down whatever won the race.
      this.deleteSession(sessionId);
      return { previewUrl };
    }

    // The session now accepts writes; stream any edits buffered while the
    // create was in flight (the create wrote the mount-time snapshot, so a
    // buffered edit is strictly newer — and flushing only from here on can
    // no longer race the create handler's writeFiles).
    //
    // Quiet writes count here too. They are held back from the *dev server*, not from
    // the session: a theme applied while the container was still booting has no bridge
    // to reach either (the demo has not run yet), so if this did not drain them they
    // would sit unsent until the user happened to make an ordinary edit.
    this.mounted = true;
    if (this.pending.size > 0 || this.quietPending.size > 0) void this.flush();

    // The container boots asynchronously (install + dev server). Poll status for
    // progress; only point the iframe at the preview once the dev server is up.
    this.emitProgress("Starting container…");
    this.poll();
    return { previewUrl };
  }

  private poll(): void {
    if (this.disposed || !this.sessionId) return;
    void (async () => {
      try {
        const r = await fetch(
          `${this.opts.apiBase}/api/session/${this.sessionId}/status?port=${this.port}`,
        );
        // 410 = the session was tombstoned (closed elsewhere); it can never
        // become ready, so stop polling instead of rescheduling forever.
        if (r.status === 410) {
          const failure = await readFailure(r);
          if (this.disposed || this.pointed) return;
          // The cost guardrail closing sessions at 100% of budget arrives here
          // too, and it has a real explanation to show instead of the generic
          // "closed" (which the app deliberately swallows as normal teardown).
          this.emitError(
            failure.code?.startsWith("budget_")
              ? new SessionStartError(410, failure.message, failure.code)
              : new Error("The session was closed."),
          );
          return;
        }
        if (r.ok) {
          const { ready, log, failed } = (await r.json()) as { ready: boolean; log: string; failed?: boolean };
          if (log && !this.pointed) this.emitProgress(log);
          if (failed && !this.disposed && !this.pointed) {
            // Report once, then keep polling rather than returning. Returning made the
            // failure a one-way door: the shell stopped asking the container anything,
            // so a dev server that did come up afterwards could never be picked up, and
            // the error card outlived its cause with no way back but a remount. Reporting
            // once matters as much as continuing — `onError` is wired to Sentry, and
            // re-emitting on every poll would file the same boot failure every few
            // seconds for as long as the tab stayed open.
            if (this.failedPolls === 0) {
              const detail = log
                .replace(/\x1b\[[0-9;]*m/g, "")
                .split("\n")
                .map((l) => l.trimEnd())
                .filter(Boolean)
                .slice(-40)
                .join("\n");
              this.emitError(new ContainerBootFailure(detail || "Container failed to install dependencies or start."));
            }
            this.failedPolls += 1;
            // The boot script has exited, so this is a long shot, not the recovery path —
            // "Restart preview" in the error card is. Poll on slowly for a short window in
            // case the port opens anyway, then stop instead of probing a dead container
            // for the life of the tab.
            if (this.failedPolls > FAILED_POLLS_MAX) return;
            this.pollTimer = setTimeout(() => this.poll(), FAILED_POLL_INTERVAL_MS);
            return;
          }
          if (ready && !this.disposed && !this.pointed) {
            // Dev server is up. Point the iframe at it, but keep the loading
            // indicator through the client-render phase (the SPA still has to
            // boot + render the grid after the HTML loads). We can't inspect the
            // cross-origin iframe, so: on load, wait a short grace, then ready.
            this.pointed = true;
            this.emitProgress("Dev server ready — rendering the demo…");
            this.opts.iframe.addEventListener(
              "load",
              () => setTimeout(() => this.emitReady(), this.opts.renderGraceMs ?? 3500),
              { once: true },
            );
            this.opts.iframe.src = this.previewUrl;
            // Hard fallback in case the load event never fires.
            setTimeout(() => this.emitReady(), 20000);
            // Keep the container awake while the demo is open so it never has to
            // cold-boot again mid-session. Any request resets sleepAfter; we ping
            // only while the tab is visible so a backgrounded/closed tab lets it
            // scale to zero (stop billing) after the idle window.
            this.startKeepalive();
            return;
          }
        }
      } catch {
        /* transient; keep polling */
      }
      if (!this.disposed) this.pollTimer = setTimeout(() => this.poll(), 2500);
    })();
  }

  /** Stream an edit; the container dev server HMRs it. Debounced per burst.
   *  An edit made while the create POST is still in flight is buffered
   *  (flush() is gated on `mounted`) and streamed as soon as it succeeds.
   *
   *  `quiet` holds the write back from the dev server (DEV-2496): the Style panel has
   *  already patched the running theme over the bridge, and streaming the file would
   *  buy nothing but a page reload — the worst version of this bug, since a reload
   *  loses the grid's scroll and selection. The file is stored the same way, and
   *  `quietPending` is drained by the next `flush()` (any edit, `reload()` or
   *  `flushQuiet()`), so the container never serves a theme older than the panel's. */
  writeFile(path: string, contents: string, opts: WriteFileOptions = {}): void {
    if (!this.sessionId) throw new Error("ContainerRuntime.writeFile called before mount()");
    this.files = { ...this.files, [path]: contents };
    // A path lives in exactly one of the two maps: whichever kind of write came last
    // holds the newest contents, and letting both keep an entry would make the answer
    // depend on the order `flush()` happens to drain them in. Hand-edit the theme module
    // and touch the panel inside the debounce window and that is a real disagreement —
    // the container ends up serving the older of the two.
    this.pending.delete(path);
    this.quietPending.delete(path);
    if (opts.quiet) {
      this.quietPending.set(path, contents);
      return;
    }
    this.pending.set(path, contents);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), this.opts.writeDebounceMs ?? 250);
  }

  /** Stream whatever the quiet writes have been holding, now. */
  flushQuiet(): void {
    if (this.quietPending.size === 0) return;
    void this.flush();
  }

  /** Re-navigate the iframe to the same preview URL. The session, the container
   *  and the dev server are all left alone — only the page reloads. Before the
   *  iframe has been pointed at the preview (still booting) there is nothing to
   *  reload.
   *
   *  Resolves on the reloaded page's `load`, which is the honest completion signal
   *  here: `src` navigation is exactly what a refresh does. Cross-origin is no
   *  obstacle — `load` fires on the frame element regardless of what it loaded. */
  async reload(): Promise<void> {
    if (this.disposed || !this.pointed || !this.previewUrl) return;
    // Held-back writes have to reach the dev server *before* the navigation, or the
    // reloaded page serves a theme older than the one the panel is showing. Guarded
    // because this method must not reject: the shell's refresh spinner is cleared by
    // this promise settling, and `flush()` throwing would leave it up for good.
    if (this.quietPending.size > 0) {
      try {
        await this.flush();
      } catch { /* a write that failed reports through onError, not through refresh */ }
    }
    if (this.disposed || !this.pointed || !this.previewUrl) return;
    return new Promise<void>((resolve) => {
      const iframe = this.opts.iframe;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        iframe.removeEventListener("load", settle);
        this.reloadSettlers.delete(settle);
        resolve();
      };
      // A container whose dev server died never navigates, and an unresolved promise
      // would leave the shell's spinner up forever. The promise reports "no longer in
      // flight", not success, so resolving on timeout is the correct outcome.
      const timer = setTimeout(settle, RELOAD_TIMEOUT_MS);
      this.reloadSettlers.add(settle);
      iframe.addEventListener("load", settle, { once: true });
      iframe.src = this.previewUrl;
    });
  }

  /** Remove a file from the running container (file-tree delete/rename). */
  deleteFile(path: string): void {
    if (!this.sessionId) return;
    this.pending.delete(path);
    this.quietPending.delete(path);
    const next = { ...this.files };
    delete next[path];
    this.files = next;
    // Mid-create there is nothing to delete server-side yet, and the RPC
    // would race the create's own writeFiles. Local removal is enough: the
    // pre-existing limitation that a mid-boot delete does not propagate to
    // the already-snapshotted container is unchanged.
    if (!this.mounted) return;
    void fetch(
      `${this.opts.apiBase}/api/session/${this.sessionId}/file?path=${encodeURIComponent(relativePath(path))}`,
      { method: "DELETE" },
    ).catch(() => {});
  }

  /** Ping the session periodically (while the tab is visible) to reset the
   *  container's sleepAfter timer, keeping the dev server warm during use. */
  private startKeepalive(): void {
    if (this.keepaliveTimer || this.disposed) return;
    const intervalMs = this.opts.keepaliveMs ?? 60000;
    this.keepaliveTimer = setInterval(() => {
      if (this.disposed || !this.sessionId) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetch(`${this.opts.apiBase}/api/session/${this.sessionId}/status?port=${this.port}`)
        .then(async (r) => {
          // Session tombstoned elsewhere — pinging it forever is pointless.
          if (r.status !== 410) return;
          if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
          }
          // The keepalive is also how a *running* session learns the cost
          // ceiling closed it (the server destroys the container on this
          // request). Without this the preview would just quietly go stale.
          const failure = await readFailure(r);
          if (this.disposed || !failure.code?.startsWith("budget_")) return;
          if (this.pointed) this.opts.iframe.src = "about:blank";
          this.emitError(new SessionStartError(410, failure.message, failure.code));
        })
        .catch(() => {});
    }, intervalMs);
  }

  private async flush() {
    // Gated on `mounted`: a flush before the create POST succeeds would race
    // the create handler's writeFiles. Buffered edits are flushed by mount().
    if (!this.mounted || !this.sessionId || this.disposed) return;
    // Quiet writes go out with whatever prompted this flush. Order does not decide
    // anything — `writeFile` keeps a path in one map only — so this is just "everything
    // that is waiting".
    const batch = [...this.quietPending.entries(), ...this.pending.entries()];
    this.quietPending.clear();
    this.pending.clear();
    for (const [path, contents] of batch) {
      // Re-check per iteration: a dispose() during an earlier await must stop
      // the rest of the batch — writes to a torn-down session are pointless
      // (and, unguarded server-side, would resurrect its container).
      if (!this.sessionId || this.disposed) return;
      try {
        await fetch(`${this.opts.apiBase}/api/session/${this.sessionId}/file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: relativePath(path), contents }),
        });
      } catch (e) {
        this.emitError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  /** Best-effort server-side session destroy; the container also auto-sleeps.
   *  keepalive lets the request outlive the page when this runs from pagehide
   *  (tab close). Takes the id explicitly so callers can tear down a session
   *  whose id dispose() has already nulled (mid-flight mount races). */
  private deleteSession(id: string): void {
    void fetch(`${this.opts.apiBase}/api/session/${id}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("pagehide", this.onPagehide);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    // Point the preview away from the dead session. Preview traffic proxies
    // straight to the container BEFORE any tombstone check (proxyToSandbox is
    // the Worker's first routing step), so a still-mounted iframe — above all
    // its Vite HMR WebSocket reconnect loop — would resurrect the container
    // this dispose just destroyed.
    if (this.pointed) this.opts.iframe.src = "about:blank";
    // On the `pointed` path that `about:blank` fires its own `load` and would settle
    // these anyway; doing it here too costs a line and drops the ordering assumption.
    for (const settle of [...this.reloadSettlers]) settle();
    this.progressCbs.clear();
    const id = this.sessionId;
    this.sessionId = null;
    this.readyCbs.clear();
    this.errorCbs.clear();
    if (id) this.deleteSession(id);
  }
}
