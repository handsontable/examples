// ContainerRuntime — Tier-2 engine. Implements the same DemoRuntime interface as
// SandpackRuntime, so the editor shell drives a Remix/Next/Astro/Nuxt/Angular
// demo exactly like a React one. Behind the interface it talks to the
// orchestration Worker: POST a session (files -> real dev server in a Cloudflare
// Sandbox container) and point the preview iframe at the container preview URL;
// stream edits as file writes that the dev server HMRs.
//
// DOM-only: imported via the "@handsontable/demo-runtime/container" subpath so it
// is never bundled into the (non-DOM) Worker itself.

import type { CatalogEntry, DemoRuntime, FilesMap, HandsontableVersionRef } from "./types.js";
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
 * follow-up DELETE would only re-extend its tombstone) from other failures. */
export class SessionStartError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

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
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly progressCbs = new Set<(log: string) => void>();
  private previewUrl = "";
  private port = 0;
  private pointed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          framework: this.entry.framework,
          files: relativeFiles(this.files),
          sessionId,
          htVersion: this.opts.version?.ref,
        }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new SessionStartError(res.status, `session start failed (${res.status}): ${msg}`);
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
    this.mounted = true;
    if (this.pending.size > 0) void this.flush();

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
          if (!this.disposed && !this.pointed) this.emitError(new Error("The session was closed."));
          return;
        }
        if (r.ok) {
          const { ready, log, failed } = (await r.json()) as { ready: boolean; log: string; failed?: boolean };
          if (log && !this.pointed) this.emitProgress(log);
          if (failed && !this.disposed && !this.pointed) {
            const detail = log
              .replace(/\x1b\[[0-9;]*m/g, "")
              .split("\n")
              .map((l) => l.trimEnd())
              .filter(Boolean)
              .slice(-40)
              .join("\n");
            this.emitError(new ContainerBootFailure(detail || "Container failed to install dependencies or start."));
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
   *  (flush() is gated on `mounted`) and streamed as soon as it succeeds. */
  writeFile(path: string, contents: string): void {
    if (!this.sessionId) throw new Error("ContainerRuntime.writeFile called before mount()");
    this.files = { ...this.files, [path]: contents };
    this.pending.set(path, contents);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), this.opts.writeDebounceMs ?? 250);
  }

  /** Re-navigate the iframe to the same preview URL. The session, the container
   *  and the dev server are all left alone — only the page reloads. Before the
   *  iframe has been pointed at the preview (still booting) there is nothing to
   *  reload. */
  reload(): void {
    if (this.disposed || !this.pointed || !this.previewUrl) return;
    this.opts.iframe.src = this.previewUrl;
  }

  /** Remove a file from the running container (file-tree delete/rename). */
  deleteFile(path: string): void {
    if (!this.sessionId) return;
    this.pending.delete(path);
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
        .then((r) => {
          // Session tombstoned elsewhere — pinging it forever is pointless.
          if (r.status === 410 && this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
          }
        })
        .catch(() => {});
    }, intervalMs);
  }

  private async flush() {
    // Gated on `mounted`: a flush before the create POST succeeds would race
    // the create handler's writeFiles. Buffered edits are flushed by mount().
    if (!this.mounted || !this.sessionId || this.disposed) return;
    const batch = [...this.pending.entries()];
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
    this.progressCbs.clear();
    const id = this.sessionId;
    this.sessionId = null;
    this.readyCbs.clear();
    this.errorCbs.clear();
    if (id) this.deleteSession(id);
  }
}
