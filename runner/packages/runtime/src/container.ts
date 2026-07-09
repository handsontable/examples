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
import { applyHandsontableVersion } from "./version.js";

export interface ContainerRuntimeOptions {
  /** The shell's preview-iframe slot; its src is set to the container preview URL. */
  iframe: HTMLIFrameElement;
  /** Origin of the orchestration Worker (e.g. http://localhost:8787). */
  apiBase: string;
  /** Pin Handsontable to this version before starting the session. */
  version?: HandsontableVersionRef;
  /** Optional stable session id (else the server generates one). */
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
    this.files = this.opts.version ? applyHandsontableVersion(files, this.opts.version) : files;

    const res = await fetch(`${this.opts.apiBase}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        framework: this.entry.framework,
        files: this.files,
        sessionId: this.opts.sessionId,
        htVersion: this.opts.version?.ref,
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`session start failed (${res.status}): ${msg}`);
    }
    const { sessionId, previewUrl, port } = (await res.json()) as {
      sessionId: string;
      previewUrl: string;
      port: number;
    };
    this.sessionId = sessionId;
    this.previewUrl = previewUrl;
    this.port = port;

    if (this.disposed) return { previewUrl };

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
        if (r.ok) {
          const { ready, log } = (await r.json()) as { ready: boolean; log: string };
          if (log && !this.pointed) this.emitProgress(log);
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

  /** Stream an edit; the container dev server HMRs it. Debounced per burst. */
  writeFile(path: string, contents: string): void {
    if (!this.sessionId) throw new Error("ContainerRuntime.writeFile called before mount()");
    this.files = { ...this.files, [path]: contents };
    this.pending.set(path, contents);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), this.opts.writeDebounceMs ?? 250);
  }

  /** Remove a file from the running container (file-tree delete/rename). */
  deleteFile(path: string): void {
    if (!this.sessionId) return;
    this.pending.delete(path);
    const next = { ...this.files };
    delete next[path];
    this.files = next;
    void fetch(
      `${this.opts.apiBase}/api/session/${this.sessionId}/file?path=${encodeURIComponent(path)}`,
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
      void fetch(`${this.opts.apiBase}/api/session/${this.sessionId}/status?port=${this.port}`).catch(() => {});
    }, intervalMs);
  }

  private async flush() {
    if (!this.sessionId || this.disposed) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [path, contents] of batch) {
      try {
        await fetch(`${this.opts.apiBase}/api/session/${this.sessionId}/file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, contents }),
        });
      } catch (e) {
        this.emitError(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.progressCbs.clear();
    const id = this.sessionId;
    this.sessionId = null;
    this.readyCbs.clear();
    this.errorCbs.clear();
    if (id) {
      // Best-effort teardown; container also auto-sleeps.
      void fetch(`${this.opts.apiBase}/api/session/${id}`, { method: "DELETE" }).catch(() => {});
    }
  }
}
