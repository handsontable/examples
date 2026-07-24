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
import { transpileFilesForParcel } from "./transpile.js";
import { applyHandsontableCss, applyHandsontableVersion } from "./version.js";

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

/**
 * DEV-2129: `parcel` is the only classic-bundler environment that shares
 * Handsontable's internal module registry across entry points — under the
 * `create-react-app(-typescript)` environments the registry is duplicated, so
 * plugin registration never reaches the grid (`getPlugin()` returns undefined,
 * context menu / sorting / dialog etc. are silently dead). Route every Tier-1
 * sandbox through `parcel`; its 2018-era transpiler can't parse TS/JSX/ES2018+,
 * so sources are pre-compiled client-side (see transpile.ts) before mounting.
 */
function normalizeEnv(env: string | null | undefined): string | undefined {
  if (env === "create-react-app" || env === "create-react-app-typescript") return "parcel";
  return env ?? undefined;
}

/** Map an authored entry path to its compiled name in the parcel sandbox. */
function toParcelEntry(path: string): string {
  return path.replace(/\.(tsx|ts|jsx)$/, ".js");
}

/**
 * Strip `<base>` tags from HTML files. A `<base href=".">` (used by some Vite
 * examples) breaks relative URL resolution inside the bundler's preview iframe,
 * leaving a blank preview even though the code compiled.
 */
function sanitizeHtml(files: FilesMap): FilesMap {
  let changed = false;
  const out: FilesMap = {};
  for (const [path, code] of Object.entries(files)) {
    if (path.toLowerCase().endsWith(".html") && /<base\b[^>]*>/i.test(code)) {
      out[path] = code.replace(/<base\b[^>]*>\s*/gi, "");
      changed = true;
    } else {
      out[path] = code;
    }
  }
  return changed ? out : files;
}

/**
 * The in-browser bundler only resolves top-level dependencies, but
 * handsontable's dist requires `@swc/helpers` at runtime (normally pulled in as
 * handsontable's own npm dependency). Add it explicitly so the bundler fetches
 * it. Extend this map if other transitive runtime deps surface.
 */
function ensureSandpackDeps(files: FilesMap): FilesMap {
  const raw = files["/package.json"];
  if (raw === undefined) return files;
  let pkg: { dependencies?: Record<string, string>; [k: string]: unknown };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return files;
  }
  const deps: Record<string, string> = { ...(pkg.dependencies ?? {}) };
  // handsontable's dist needs @swc/helpers at runtime.
  if (deps.handsontable && !deps["@swc/helpers"]) deps["@swc/helpers"] = "^0.5.17";
  // @handsontable/pikaday needs pikaday, which needs moment (+ jquery for the
  // jquery build). The in-browser bundler doesn't pull nested deps, so add them.
  if (deps["@handsontable/pikaday"]) {
    if (!deps.pikaday) deps.pikaday = "^1.8.2";
    if (!deps.moment) deps.moment = "^2.30.1";
    if (!deps.jquery) deps.jquery = "^3.7.1";
  }
  return { ...files, "/package.json": JSON.stringify({ ...pkg, dependencies: deps }, null, 2) + "\n" };
}

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
    if (entry.engine !== "sandpack") {
      throw new Error(`SandpackRuntime requires engine 'sandpack'; ${entry.framework} is '${entry.engine}'`);
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
  private async buildSetup(files: FilesMap): Promise<SandboxSetup> {
    const pinned = this.opts.version
      ? applyHandsontableCss(applyHandsontableVersion(files, this.opts.version), this.opts.version)
      : files;
    // `this.files` always holds the authored sources; parcel's compiled view is
    // derived from it on every (re)build and never fed back into the editor.
    this.files = sanitizeHtml(ensureSandpackDeps(pinned));
    return this.setupFrom(await this.sandboxFiles());
  }

  private get env(): string | undefined {
    return normalizeEnv(this.entry.sandpackEnvironment);
  }

  /** The files the bundler sees: pre-transpiled for parcel, authored otherwise. */
  private sandboxFiles(): Promise<FilesMap> | FilesMap {
    return this.env === "parcel" ? transpileFilesForParcel(this.files) : this.files;
  }

  private setupFrom(files: FilesMap): SandboxSetup {
    const sandpackFiles: Record<string, { code: string }> = {};
    for (const [path, code] of Object.entries(files)) {
      sandpackFiles[path] = { code };
    }

    const env = this.env;
    const entryPath =
      env && HTML_ENTRY_ENVS.has(env) && this.entry.htmlEntry
        ? this.entry.htmlEntry
        : env === "parcel"
          ? toParcelEntry(this.entry.entry)
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
    const setup = await this.buildSetup(files);
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
    this.pushUpdate();
  }

  /** Remove a file and recompile (file-tree delete/rename). */
  deleteFile(path: string): void {
    if (!this.client) return;
    const next = { ...this.files };
    delete next[path];
    this.files = next;
    this.pushUpdate();
  }

  /**
   * Recompute the sandbox from `this.files` and push it. Transpilation is
   * async, so guard with a sequence number: only the newest edit wins, stale
   * results are dropped. A transpile failure (half-typed code) keeps the last
   * good sandbox instead of surfacing an error for every keystroke.
   */
  private updateSeq = 0;
  private pushUpdate(): void {
    const seq = ++this.updateSeq;
    Promise.resolve(this.sandboxFiles())
      .then((files) => {
        if (!this.client || seq !== this.updateSeq) return;
        this.client.updateSandbox(this.setupFrom(files));
      })
      .catch(() => {
        /* mid-edit parse error — the user is still typing */
      });
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
