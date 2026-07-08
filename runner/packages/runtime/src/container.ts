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

  constructor(entry: CatalogEntry, opts: ContainerRuntimeOptions) {
    if (entry.tier !== 2) {
      throw new Error(`ContainerRuntime is Tier 2 only; ${entry.framework} is Tier ${entry.tier}`);
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
  private emitReady() {
    if (this.didReady) return;
    this.didReady = true;
    for (const cb of this.readyCbs) cb();
  }
  private emitError(e: Error) {
    for (const cb of this.errorCbs) cb(e);
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
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`session start failed (${res.status}): ${msg}`);
    }
    const { sessionId, previewUrl } = (await res.json()) as {
      sessionId: string;
      previewUrl: string;
    };
    this.sessionId = sessionId;

    if (this.disposed) return { previewUrl };

    // Fire ready once the preview iframe finishes its first load.
    this.opts.iframe.addEventListener("load", () => this.emitReady(), { once: true });
    this.opts.iframe.src = previewUrl;
    return { previewUrl };
  }

  /** Stream an edit; the container dev server HMRs it. Debounced per burst. */
  writeFile(path: string, contents: string): void {
    if (!this.sessionId) throw new Error("ContainerRuntime.writeFile called before mount()");
    this.files = { ...this.files, [path]: contents };
    this.pending.set(path, contents);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), this.opts.writeDebounceMs ?? 250);
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
