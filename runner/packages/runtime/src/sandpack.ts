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
import { applyDepShims } from "./dep-shims.js";
import { resolveSandboxEntry } from "./sandbox-entry.js";
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

/**
 * Which runtime instance last pointed a given iframe. The mount effect disposes the old
 * runtime and mounts a new one on the *same* iframe, so "am I disposed?" is not enough to
 * decide whether blanking is safe — the successor may already own the frame.
 */
const IFRAME_OWNER = new WeakMap<HTMLIFrameElement, object>();

export class SandpackRuntime implements DemoRuntime {
  private readonly entry: CatalogEntry;
  private readonly opts: SandpackRuntimeOptions;
  private client: SandpackClientInstance | null = null;
  private files: FilesMap = {};
  private readonly readyCbs = new Set<() => void>();
  private readonly errorCbs = new Set<(e: Error) => void>();
  private unlisten: (() => void) | null = null;
  private didReady = false;
  /** Set by `dispose()`. `loadSandpackClient` points the iframe at the bundler itself,
   *  so a mount still in flight when we are disposed would resurrect a torn-down
   *  preview after the caller had already blanked it. */
  private disposed = false;
  /** Our claim on the iframe, registered in `mount()` before the first await. */
  private claim: object | null = null;

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

  /**
   * The files the bundler sees: pre-transpiled for parcel (with dependency
   * shims for dists babel 6 cannot parse — see dep-shims.ts), authored
   * otherwise. Shims are cached per package version, so streaming edits only
   * pay for them once.
   */
  private sandboxFiles(): Promise<FilesMap> | FilesMap {
    return this.env === "parcel"
      ? transpileFilesForParcel(this.files).then(applyDepShims)
      : this.files;
  }

  private setupFrom(files: FilesMap): SandboxSetup {
    const sandpackFiles: Record<string, { code: string }> = {};
    for (const [path, code] of Object.entries(files)) {
      sandpackFiles[path] = { code };
    }

    const env = this.env;
    // Throws when the resolved entry file is absent from the sandbox files
    // (DEV-2130) — on mount the rejection surfaces as "Setup failed" instead
    // of a silent blank preview; on streaming updates pushUpdate()'s catch
    // keeps the last good sandbox.
    const entryPath = resolveSandboxEntry(env, this.entry.entry, this.entry.htmlEntry, files);

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
    // Claim the iframe before the first await, so a successor mounting on the same frame
    // takes ownership synchronously and this instance can tell it has been superseded.
    const claim = {};
    this.claim = claim;
    IFRAME_OWNER.set(this.opts.iframe, claim);

    const setup = await this.buildSetup(files);
    const client = await loadSandpackClient(this.opts.iframe, setup, this.clientOptions());

    // Both awaits above can outlive a `dispose()`. `loadSandpackClient` has by now pointed
    // the iframe at the bundler origin, so returning quietly is not enough — undo it, or a
    // preview the caller deliberately stopped comes back to life.
    if (this.disposed) {
      client.destroy?.();
      // Only if nobody else has claimed the frame since. The mount effect disposes the old
      // runtime and immediately mounts a new one on this same iframe, and blanking there
      // would kill the successor's live preview instead of our own dead one.
      if (IFRAME_OWNER.get(this.opts.iframe) === claim) this.opts.iframe.src = "about:blank";
      return { previewUrl: "" };
    }

    this.client = client;
    this.unlisten = this.client.listen((msg: unknown) => this.onMessage(msg));
    return { previewUrl: this.opts.iframe.src };
  }

  private onMessage(msg: unknown) {
    const m = msg as { type?: string; action?: string; compilatonError?: boolean; message?: string };
    switch (m.type) {
      case "done":
        // (`compilatonError` is misspelled in the upstream payload. Leave it.)
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

  /** Re-run the sandbox from the current sources — the refresh button. No new client, no
   *  reload of the bundler itself; an ordinary compile push does the whole job.
   *
   *  It must **not** ask for an initialization compile (DEV-2176). The bundler drops every
   *  `compile` carrying `isInitializationCompile: true` after the first one, and
   *  `loadSandpackClient` spends that single allowance itself when it replays the setup on
   *  the bundler's `initialized` message — so a refresh that set the flag was discarded in
   *  silence: no `start`, no `done`, no error, and the preview never re-ran. The flag
   *  suppresses re-compiles rather than requesting one. A plain push is the real thing:
   *  measured against the live bundler, a non-initial compile with byte-identical sources
   *  re-transpiles, resets the sandbox document and re-evaluates the entry, leaving one
   *  grid with its plugins registered.
   *
   *  Settles once our transpile is done and the update has been handed to the bundler, not
   *  on the bundler's `done`. `done` is available again now that the compile actually runs,
   *  but claiming it here would need a waiter keyed to *this* push, and `reload()` shares
   *  `updateSeq` with `writeFile` on purpose (see `pushUpdate`), so a refresh overtaken by
   *  a keystroke has no `done` of its own to wait for. The transpile-and-dispatch edge is
   *  work we perform and can time (48–62ms on a warm React starter). */
  reload(): Promise<void> {
    if (!this.client) return Promise.resolve();
    return this.pushUpdate();
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
   * results are dropped. A transpile failure (half-typed code) or a
   * transiently missing entry (mid-rename) keeps the last good sandbox
   * instead of surfacing an error for every keystroke.
   *
   * `reload()` shares this path rather than having its own so the sequence guard covers it
   * too: claiming the sequence *before* the await is the whole point, and a refresh that
   * claimed it afterwards could publish its own pre-keystroke transpile over a newer edit
   * and then make that edit's result look stale.
   *
   * Every push goes out as a non-initial compile. The bundler ignores initialization
   * compiles after its first (DEV-2176, see `reload()`), and a plain compile re-evaluates
   * the sandbox anyway.
   *
   * Returns a promise that settles once the push has been *dispatched* — or dropped as
   * superseded, or failed to transpile. `reload()` reports that edge as its completion.
   */
  private updateSeq = 0;
  private pushUpdate(): Promise<void> {
    const seq = ++this.updateSeq;
    return Promise.resolve(this.sandboxFiles())
      .then((files) => {
        if (!this.client || seq !== this.updateSeq) return;
        this.client.updateSandbox(this.setupFrom(files), false);
      })
      .catch(() => {
        /* mid-edit parse error — the user is still typing */
      });
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.unlisten?.();
    } finally {
      this.unlisten = null;
      this.client?.destroy?.();
      this.client = null;
      this.readyCbs.clear();
      this.errorCbs.clear();
      // No reload bookkeeping to drain: `reload()` settles on its own transpile, and
      // `pushUpdate` always settles (it catches), so a dispose mid-refresh cannot leave a
      // promise hanging.
    }
  }
}

/** Factory matching RuntimeFactories["sandpack"], with shared options closed over. */
export function makeSandpackFactory(base: Omit<SandpackRuntimeOptions, "version"> & { version?: HandsontableVersionRef }) {
  return (entry: CatalogEntry) => new SandpackRuntime(entry, base);
}
