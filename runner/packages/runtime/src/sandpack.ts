// SandpackRuntime — Tier-1 engine. Wraps @codesandbox/sandpack-client (the
// classic, client-side, in-browser bundler) behind the DemoRuntime interface.
// No server, no per-view cost. Phase 1 targets Sandpack's hosted bundler; set
// `bundlerURL` to a self-hosted deployment for Phase 2 (docs/self-host-bundler.md).
//
// White-label: showOpenInCodeSandbox is disabled and no CodeSandbox marks are
// surfaced. Sandpack is Apache-2.0 — license notice stays in source only.
//
// DOM-only: imported via the "@handsontable/demo-runtime/sandpack" subpath so it
// is never bundled into the (non-DOM) sharing Worker.

import { loadSandpackClient } from "@codesandbox/sandpack-client";
import type { CatalogEntry, DemoRuntime, FilesMap, HandsontableVersionRef } from "./types.js";
import { applyHandsontableVersion } from "./version.js";

// Derive Sandpack's option/setup types straight from the loader signature so we
// don't depend on the package's exported type names staying stable.
type SandpackClientInstance = Awaited<ReturnType<typeof loadSandpackClient>>;
type SandboxSetup = Parameters<typeof loadSandpackClient>[1];
type ClientOptions = Parameters<typeof loadSandpackClient>[2];

export interface SandpackRuntimeOptions {
  /** The shell's preview-iframe slot. Sandpack renders the preview into it. */
  iframe: HTMLIFrameElement;
  /** Phase-1 hosted bundler by default; set to a self-hosted URL for Phase 2. */
  bundlerURL?: string;
  /** Pin Handsontable to this version before mounting. */
  version?: HandsontableVersionRef;
}

/** Environments whose entry point is the HTML file rather than a JS/TS module. */
const HTML_ENTRY_ENVS = new Set(["parcel", "static"]);

export class SandpackRuntime implements DemoRuntime {
  private readonly entry: CatalogEntry;
  private readonly opts: SandpackRuntimeOptions;
  private client: SandpackClientInstance | null = null;
  private files: FilesMap = {};
  private readonly readyCbs = new Set<() => void>();
  private readonly errorCbs = new Set<(e: Error) => void>();
  private unlisten: (() => void) | null = null;
  private didReady = false;

  constructor(entry: CatalogEntry, opts: SandpackRuntimeOptions) {
    if (entry.tier !== 1) {
      throw new Error(`SandpackRuntime is Tier 1 only; ${entry.framework} is Tier ${entry.tier}`);
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

  /** Apply version dispatch, then shape files into a Sandpack sandbox setup. */
  private buildSetup(files: FilesMap): SandboxSetup {
    const pinned = this.opts.version
      ? applyHandsontableVersion(files, this.opts.version)
      : files;
    this.files = pinned;

    const sandpackFiles: Record<string, { code: string }> = {};
    for (const [path, code] of Object.entries(pinned)) {
      sandpackFiles[path] = { code };
    }

    const env = this.entry.sandpackEnvironment ?? undefined;
    const entryPath =
      env && HTML_ENTRY_ENVS.has(env) && this.entry.htmlEntry
        ? this.entry.htmlEntry
        : this.entry.entry;

    return {
      files: sandpackFiles,
      entry: entryPath,
      // Dependencies are read from the injected /package.json by the bundler.
      template: env,
    } as SandboxSetup;
  }

  private clientOptions(): ClientOptions {
    const options: Record<string, unknown> = {
      showOpenInCodeSandbox: false,
      showErrorScreen: true,
      showLoadingScreen: true,
    };
    if (this.opts.bundlerURL) options.bundlerURL = this.opts.bundlerURL;
    return options as ClientOptions;
  }

  async mount(files: FilesMap): Promise<{ previewUrl: string }> {
    const setup = this.buildSetup(files);
    this.client = await loadSandpackClient(this.opts.iframe, setup, this.clientOptions());

    this.unlisten = this.client.listen((msg: unknown) => this.onMessage(msg));
    return { previewUrl: this.opts.iframe.src };
  }

  private onMessage(msg: unknown) {
    const m = msg as { type?: string; action?: string; compilatonError?: boolean; message?: string };
    switch (m.type) {
      case "done":
        if (m.compilatonError) return; // error surfaced via its own message
        this.emitReady();
        break;
      case "action":
        if (m.action === "show-error") {
          this.emitError(new Error(m.message || "Sandpack compile error"));
        }
        break;
      case "console":
        break;
      default:
        break;
    }
  }

  /** Stream a single edit. Sandpack recompiles incrementally. */
  writeFile(path: string, contents: string): void {
    if (!this.client) throw new Error("SandpackRuntime.writeFile called before mount()");
    this.files = { ...this.files, [path]: contents };
    const sandpackFiles: Record<string, { code: string }> = {};
    for (const [p, code] of Object.entries(this.files)) sandpackFiles[p] = { code };
    this.client.updateSandbox({ ...this.buildSetupFrom(sandpackFiles) } as SandboxSetup);
  }

  private buildSetupFrom(sandpackFiles: Record<string, { code: string }>): SandboxSetup {
    const env = this.entry.sandpackEnvironment ?? undefined;
    const entryPath =
      env && HTML_ENTRY_ENVS.has(env) && this.entry.htmlEntry
        ? this.entry.htmlEntry
        : this.entry.entry;
    return { files: sandpackFiles, entry: entryPath, template: env } as SandboxSetup;
  }

  dispose(): void {
    try {
      this.unlisten?.();
    } finally {
      this.unlisten = null;
      this.client?.destroy?.();
      this.client = null;
      this.readyCbs.clear();
      this.errorCbs.clear();
    }
  }
}

/** Factory matching RuntimeFactories["sandpack"], with shared options closed over. */
export function makeSandpackFactory(base: Omit<SandpackRuntimeOptions, "version"> & { version?: HandsontableVersionRef }) {
  return (entry: CatalogEntry) => new SandpackRuntime(entry, base);
}
