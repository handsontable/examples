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
import type {
  CatalogEntry,
  DemoRuntime,
  FilesMap,
  HandsontableVersionRef,
  WriteFileOptions,
} from "./types.js";
import { transpileFilesForParcel } from "./transpile.js";
import { applyDepShims } from "./dep-shims.js";
import { resolveSandboxEntry, toParcelEntry } from "./sandbox-entry.js";
import {
  MONITOR_COMPILE_MESSAGE_MAX,
  injectReporter,
  redactPreviewHosts,
  truncateMessage,
} from "./monitor.js";
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
  /**
   * Inject the demo-runtime monitor into the preview (DEV-2527). Passed in rather
   * than read from the environment here: this package is also loaded by the
   * (non-DOM) sharing Worker, and the flag lives in the app's build.
   */
  monitor?: boolean;
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
  // Upstream pikaday (what docs examples import after DEV-2180) resolves moment
  // through `try { require('moment') }` in its UMD wrapper. Today's examples
  // import moment themselves; this only covers a picker-only example.
  else if (deps.pikaday && !deps.moment) {
    deps.moment = "^2.30.1";
  }
  return { ...files, "/package.json": JSON.stringify({ ...pkg, dependencies: deps }, null, 2) + "\n" };
}

/**
 * Which runtime instance last pointed a given iframe. The mount effect disposes the old
 * runtime and mounts a new one on the *same* iframe, so "am I disposed?" is not enough to
 * decide whether blanking is safe — the successor may already own the frame.
 */
const IFRAME_OWNER = new WeakMap<HTMLIFrameElement, object>();

/** Same paths, same contents. Compared key by key rather than by serialising both maps:
 *  this runs on every keystroke, and a sandbox carries the compiled sources *and* the
 *  dependency shims — hundreds of KB it would be pointless to stringify to learn that one
 *  character changed. */
function sameFiles(a: FilesMap, b: FilesMap | null): boolean {
  if (b === null) return false;
  const paths = Object.keys(a);
  if (paths.length !== Object.keys(b).length) return false;
  return paths.every((path) => a[path] === b[path]);
}

/**
 * A compile diagnostic from the in-browser bundler, as reported to the shell.
 *
 * Named, because it is the exception type Sentry puts in the issue title: a bare
 * `Error` there reads as an application crash, and the first line of a bundler
 * message about visitor-authored code was in fact read that way once (DEV-2550 was
 * filed against the app for text the bundler produced about a demo's own source).
 *
 * Always constructed from a string, never wrapped around an error the handler was
 * handed — see `boundCompileMessage`.
 */
export class SandpackCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandpackCompileError";
  }
}

const COMPILE_ERROR_FALLBACK = "Sandpack compile error";

/** Inline source maps the bundler echoes back inside a compile message. A
 *  `data:application/json;base64,…` blob is kilobytes of noise around the one line
 *  that says what is wrong; the marker is kept so the line still reads. */
const INLINE_SOURCE_MAP = /sourceMappingURL=data:[^\s'"*]*/gi;

/**
 * Bound the bundler's `show-error` string (DEV-2550).
 *
 * This is third-party output about code an anonymous visitor wrote, and it was the
 * only DEV-2527 channel that reached both the error card and `Sentry.captureException`
 * unbounded — the observed payload (DEMOS-15) was a babel code frame followed by a
 * multi-kilobyte inline source map, so the diagnostic was buried in the card and the
 * Sentry event was mostly base64. `reportDemoEvent` bounds its channel through
 * `sanitizeMonitorPayload`, container stderr through `truncateMessage`; this is the
 * same treatment for this one.
 *
 * Order is load-bearing twice over. Source maps are stripped *first*, so the cap
 * spends its budget on the diagnostic instead of on half a blob. Hosts are then
 * redacted *before* truncation — the security property monitor.ts documents on
 * `bound()`: truncating first can cut a preview hostname in half and strand a live
 * session token in a form the redactor no longer recognises.
 *
 * Takes `unknown` and coerces, matching `truncateMessage`: the payload crossed an
 * origin boundary from a page running the visitor's code, so its shape is not a
 * promise. It never reads-and-writes a property of its input — the returned message
 * always goes into a *new* `SandpackCompileError`. A caught error can be frozen (a
 * babel `SyntaxError` carries a non-writable `message`, which is precisely what the
 * text in DEMOS-15 is about), and "rewrite the message in place" is the shape that
 * turns a report into a throw.
 *
 * The coercion itself is the other way this handler could throw instead of
 * reporting, and it predates this fix (`new Error(value)` stringifies too). `message`
 * is whatever survived a structured clone from the preview window, and a plain object
 * with a non-callable `toString` — `{ toString: 42 }`, perfectly clonable — makes
 * `String()` raise "Cannot convert object to primitive value". Sandpack's
 * `IFrameProtocol.eventListener` runs its channel listeners in a bare `forEach` with
 * no `try`, so that TypeError would abort the dispatch, leave the error card on the
 * last good state, and surface as an unrelated window-level fault. Fall back instead.
 */
function boundCompileMessage(value: unknown): string {
  let raw: string;
  if (typeof value === "string") raw = value;
  else if (value === undefined || value === null) raw = "";
  else {
    try {
      raw = String(value);
    } catch {
      return COMPILE_ERROR_FALLBACK;
    }
  }
  if (raw.trim() === "") return COMPILE_ERROR_FALLBACK;
  const withoutMaps = raw.replace(INLINE_SOURCE_MAP, "sourceMappingURL=<omitted>");
  return truncateMessage(redactPreviewHosts(withoutMaps), MONITOR_COMPILE_MESSAGE_MAX);
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

  /** Fires on *every* clean compile, not just the first.
   *
   *  A `done` without `compilatonError` is the bundler saying the current sources
   *  compiled and evaluated — which is exactly the signal that a preview the user
   *  broke is working again. Suppressing repeats made the error state a one-way
   *  door: `show-error` set it, and no later success could clear it (the only exits
   *  were an example switch or a version change, both of which remount).
   *
   *  `didReady` stays, but only for what it is actually needed for — replaying
   *  readiness to a callback that subscribed after the first compile. */
  private emitReady() {
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
    const sandbox = await this.sandboxFiles();
    // What the bundler is about to hold, for `pushUpdate`'s no-op check.
    this.published = sandbox;
    return this.setupFrom(sandbox);
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
      ? transpileFilesForParcel(this.files).then(applyDepShims).then((f) => this.withMonitor(f))
      : this.withMonitor(this.files);
  }

  /**
   * Add the monitor to the bundler's view of the files (DEV-2527).
   *
   * Applied here, to the *derived* map, and never to `this.files`: the authored map
   * is what Download-zip, fork and the StackBlitz/CodeSandbox exports read, and the
   * monitor must not ship inside a demo someone downloads. It also runs *after* the
   * parcel pre-transpile, so babel never has to parse it.
   *
   * A missing entry is `setupFrom()`'s error to raise, with its own message
   * (DEV-2130) — `injectReporter` returns the map untouched rather than throwing a
   * second, less useful error from here.
   */
  private withMonitor(files: FilesMap): FilesMap {
    if (!this.opts.monitor) return files;
    // Both entries, when they differ. For `parcel` — every Tier-1 example — the
    // resolved sandbox entry is the HTML file, and whether the classic bundler
    // preserves a `<script>` we put in its head is not something this code can
    // guarantee. The JS module is the belt to that braces: it is evaluated either
    // way, and `__hotRunnerMonitor` makes the second injection inert, so injecting
    // twice costs one duplicated string and removes the failure mode.
    const targets: string[] = [];
    try {
      targets.push(resolveSandboxEntry(this.env, this.entry.entry, this.entry.htmlEntry, files));
    } catch {
      // A missing entry is `setupFrom()`'s error to raise, with its own message
      // (DEV-2130). Monitoring must not pre-empt it with a worse one.
      return files;
    }
    const moduleEntry = this.env === "parcel" ? toParcelEntry(this.entry.entry) : this.entry.entry;
    if (!targets.includes(moduleEntry)) targets.push(moduleEntry);
    return targets.reduce((acc, path) => injectReporter(acc, path), files);
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
      // Off (DEV-2496). The flag rides every compile message the client sends, not just
      // the first, so the bundler threw its loading overlay over the preview on every
      // recompile — one more thing flashing on each keystroke. The client's own default
      // is `false`, and nothing here is left uncovered: the shell holds its own overlay
      // over the frame until `onReady`, which is the boot experience this stood in for.
      //
      // It was not the whole of the reported blink, though: measured on the react
      // starter, a theme edit rebuilt the grid element itself (see the base-commit run
      // of the DEV-2496 case in e2e/style-apply.spec.ts). This is the flash on top.
      showLoadingScreen: false,
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
    const m = msg as { type?: string; action?: string; compilatonError?: boolean; message?: unknown };
    switch (m.type) {
      case "done":
        // (`compilatonError` is misspelled in the upstream payload. Leave it.)
        if (m.compilatonError) return; // error surfaced via its own message
        this.emitReady();
        break;
      case "action":
        if (m.action === "show-error") {
          // Bounded and de-noised on the way in (DEV-2550): this string is the
          // bundler's, about the visitor's code, and it goes to the error card *and*
          // to Sentry. A fresh error carries it — nothing the handler received is
          // rewritten in place.
          this.emitError(new SandpackCompileError(boundCompileMessage(m.message)));
        }
        break;
      case "console":
        break;
      default:
        break;
    }
  }

  /** Stream a single edit. Sandpack recompiles incrementally.
   *
   *  `quiet` keeps the file and skips the compile (DEV-2496) — for the Style panel,
   *  which has already put the change on screen through the theme bridge. Nothing
   *  else changes: `this.files` is the authored workspace either way, so the next
   *  ordinary edit, `reload()` or `flushQuiet()` carries the held-back file along.
   *  Only `published` lags, which is exactly what makes that next push a real diff
   *  rather than the no-op `pushUpdate` skips. */
  writeFile(path: string, contents: string, opts: WriteFileOptions = {}): void {
    if (!this.client) throw new Error("SandpackRuntime.writeFile called before mount()");
    this.files = { ...this.files, [path]: contents };
    if (opts.quiet) return;
    this.pushUpdate();
  }

  /** Compile whatever the quiet writes have accumulated. `pushUpdate` compares against
   *  `published`, so with nothing held back this is a no-op push rather than a
   *  preview-blanking byte-identical compile. */
  flushQuiet(): void {
    if (!this.client) return;
    void this.pushUpdate();
  }

  /**
   * Append a changing comment to the sandbox entry, so a compile the bundler would
   * otherwise see as "no module changed" carries a real diff.
   *
   * The bundler's no-change path resets the preview document without re-evaluating
   * anything: a blank frame, reported `done` with no compile error, and nothing in the
   * console. That is what a refresh asks for and never got. One line on the entry is
   * enough to put it back on the path that re-evaluates.
   *
   * A comment, so it cannot change behaviour, and matched to the file's language: a
   * parcel/static sandbox boots from HTML, where `//` would render as text.
   *
   * Both the sandbox entry *and* the example's own module are stamped. A parcel sandbox
   * boots from `index.html`, and a changed HTML shell alone does not get the module
   * re-evaluated (measured: refresh still blanked). The script it loads is what has to
   * look different.
   */
  private compileStamp = 0;
  private stampEntry(files: FilesMap): FilesMap {
    const paths = new Set<string>();
    try {
      paths.add(resolveSandboxEntry(this.env, this.entry.entry, this.entry.htmlEntry, files));
    } catch {
      // A missing entry is setupFrom()'s error to raise, with its own message.
      return files;
    }
    const modulePath = this.env === "parcel" ? toParcelEntry(this.entry.entry) : this.entry.entry;
    if (files[modulePath] !== undefined) paths.add(modulePath);

    const stamp = ++this.compileStamp;
    const out = { ...files };
    for (const path of paths) {
      out[path] =
        out[path] +
        (path.toLowerCase().endsWith(".html")
          ? `\n<!-- hot-runner-compile ${stamp} -->\n`
          : `\n// hot-runner-compile ${stamp}\n`);
    }
    return out;
  }

  /** Re-run the sandbox from the current sources — the refresh button. No new client, no
   *  reload of the bundler itself; an ordinary compile push does the whole job.
   *
   *  It must **not** ask for an initialization compile (DEV-2176). The bundler drops every
   *  `compile` carrying `isInitializationCompile: true` after the first one, and
   *  `loadSandpackClient` spends that single allowance itself when it replays the setup on
   *  the bundler's `initialized` message — so a refresh that set the flag was discarded in
   *  silence: no `start`, no `done`, no error, and the preview never re-ran. The flag
   *  suppresses re-compiles rather than requesting one, so a plain push it is.
   *
   *  A plain push is not sufficient on its own, though — that part of the DEV-2176 note was
   *  wrong. A non-initial compile with byte-identical sources does compile (`start` …
   *  `success`, `done` with no error) but re-evaluates nothing: the preview document is
   *  reset and left blank, with not even the Handsontable banner in the console. Refresh
   *  blanked the pane for exactly that reason. `force` is what fixes it: `pushUpdate` stamps
   *  the entry and the example module (see `stampEntry`) so the bundler has a real diff, and
   *  skips the no-op check it applies to ordinary edits.
   *
   *  Settles once our transpile is done and the update has been handed to the bundler, not
   *  on the bundler's `done`. `done` is available again now that the compile actually runs,
   *  but claiming it here would need a waiter keyed to *this* push, and `reload()` shares
   *  `updateSeq` with `writeFile` on purpose (see `pushUpdate`), so a refresh overtaken by
   *  a keystroke has no `done` of its own to wait for. The transpile-and-dispatch edge is
   *  work we perform and can time (48–62ms on a warm React starter). */
  reload(): Promise<void> {
    if (!this.client) return Promise.resolve();
    return this.pushUpdate({ force: true });
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
  /** The sandbox the bundler currently holds, as published. Compared against the next
   *  candidate so a no-op compile is never sent — see `pushUpdate`. */
  private published: FilesMap | null = null;
  private pushUpdate(opts: { force?: boolean } = {}): Promise<void> {
    const seq = ++this.updateSeq;
    return Promise.resolve(this.sandboxFiles())
      .then((files) => {
        if (!this.client || seq !== this.updateSeq) return;
        const candidate = opts.force ? this.stampEntry(files) : files;
        // Skipping a byte-identical update is not an optimisation, it is the fix for a
        // blank preview. Break a source file and the transpile below throws, so nothing
        // reaches the bundler and the last good render stays on screen (correct). Undo
        // the break and the recomputed sandbox is identical to what the bundler already
        // has — and *that* compile blanks the preview, because the bundler's no-change
        // path resets the document without re-evaluating any module. Not sending it
        // leaves the render that is already correct exactly where it is.
        //
        // `reload()` passes `force`, and its stamp guarantees a diff, so the refresh
        // button still re-runs the sandbox rather than being skipped here.
        if (!opts.force && sameFiles(candidate, this.published)) return;
        // Recorded *after* the push, never before. `setupFrom` throws when the resolved
        // entry is transiently missing (mid-rename, the DEV-2130 guard), and a `published`
        // set ahead of that throw would claim the bundler holds a sandbox it never
        // received. Restoring those sources would then read as a real diff and send the
        // byte-identical compile this skip exists to prevent — the blank preview, back
        // again, on the rename path.
        const setup = this.setupFrom(candidate);
        this.client.updateSandbox(setup, false);
        this.published = candidate;
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
