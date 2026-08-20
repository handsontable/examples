// DEV-2129 — pre-transpile example sources for the classic Sandpack `parcel`
// environment. `parcel` is the only in-browser environment that shares
// Handsontable's internal module registry across entry points (so plugins
// registered via `handsontable/registry` actually reach the grid), but its
// transpiler is babel-standalone 6.26, which cannot parse TypeScript, JSX, or
// ES2018+ syntax (`?.`, `??`, object spread, …). We compile every source file
// down to that parse floor before handing the sandbox to the bundler; the
// authored files (shown in the editor) are never modified.
//
// @babel/standalone is ~3 MB, so it is loaded lazily on first use and only in
// sandboxes that need it.

import type { FilesMap } from "./types.js";
// Shared with `head-assets.ts`, which must classify a head URL exactly the way the
// `<link>` pruning below does — see html-urls.ts.
import { toFilesKey } from "./html-urls.js";

type Babel = {
  transform: (code: string, options: Record<string, unknown>) => { code?: string | null };
};

/**
 * A lazy singleton that caches the value but **not** a failure (DEMOS-15).
 *
 * The plain `promise ??= load()` form remembers a rejection for the life of the page, so
 * one failed compiler fetch left Tier 1 unable to compile anything at all. Clearing the
 * slot from inside the rejection handler is necessary but, on its own, not sufficient —
 * see `createRetryingLoader` for the browser rule that decides what a retry may ask for.
 *
 * Concurrent callers still share one in-flight load, which is the reason to cache at all:
 * @babel/standalone is ~3 MB.
 *
 * Exported for `pipeline/transpile-loader.test.mjs`: the real `loadBabel` cannot be driven
 * into failure from a test, because the dependency is installed and the import resolves.
 */
export function createLazyLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((cause: unknown) => {
      pending = null;
      throw cause;
    });
    return pending;
  };
}

/**
 * What a `CompilerUnavailableError` says, always (DEV-2569).
 *
 * Constant on purpose. A Sentry issue derives its title from `name: message` and
 * re-derives it from the newest event, so a message carrying the hashed chunk URL titles
 * the issue after one sample and renames it with the next one. That is half of what
 * DEMOS-15 was. The URL rides on `assetUrl` and reaches Sentry as an extra.
 */
export const COMPILER_UNAVAILABLE_MESSAGE = "the in-browser compiler could not be loaded";

/** The one URL in a module-load failure message, if the engine named one. Chrome says
 *  "Failed to fetch dynamically imported module: <url>" (this is the observed DEMOS-15
 *  text, so the URL is there in production); Safari says "Load failed" and names nothing,
 *  so a null here is an ordinary outcome and not a parse bug. */
export function assetUrlFrom(cause: unknown): string | null {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /(https?:\/\/[^\s"')]+)/.exec(text)?.[1] ?? null;
}

/**
 * The compiler chunk could not be fetched, and this page cannot compile Tier 1 until
 * something changes (DEV-2569, Sentry DEMOS-15).
 *
 * Two causes reach here and they are indistinguishable from inside the page, which is why
 * the user-facing wording (`describeRuntimeError` in the authoring app) never asserts
 * either one:
 *
 *  - **The asset is gone.** `apps/authoring/wrangler.jsonc` serves the app from Workers
 *    Assets with `not_found_handling: "single-page-application"`, so a deploy removes the
 *    previous build's hashed chunks and their paths answer `200 text/html` rather than a
 *    404 — the host behaviour DEV-2535 had to teach the docs loaders about. Measured on the
 *    older of the two URLs DEMOS-15 names:
 *
 *      $ curl -sI https://demos.handsontable.com/assets/babel-DtyXnKg5.js
 *      HTTP/2 200
 *      content-type: text/html
 *
 *    An HTML body is not a module. A tab that had not yet fetched the compiler when a
 *    deploy landed is asking for a file that no longer exists.
 *
 *  - **The request was refused.** Offline, an extension, a corporate proxy.
 *
 * `replay` distinguishes the throw that discovered the failure from the same error being
 * re-thrown by the latch, so the shell reports the discovery and not every keystroke after
 * it (`tier1Report` in the authoring app drops replays).
 *
 * Recognised by a marker property rather than `instanceof`, like `DocsResourceMissingError`:
 * the authoring app has to classify these without importing the runtime's internals, and an
 * `instanceof` across a bundle boundary is the check that silently starts returning false.
 */
export class CompilerUnavailableError extends Error {
  readonly compilerUnavailable = true;

  readonly assetUrl: string | null;

  readonly replay: boolean;

  constructor(cause: unknown, opts: { replay?: boolean } = {}) {
    super(COMPILER_UNAVAILABLE_MESSAGE, { cause });
    this.name = "CompilerUnavailableError";
    this.assetUrl = assetUrlFrom(cause);
    this.replay = opts.replay === true;
  }
}

/** Whether an error is the compiler-load failure above. */
export function isCompilerUnavailable(e: unknown): boolean {
  return e instanceof Error && (e as { compilerUnavailable?: boolean }).compilerUnavailable === true;
}

/**
 * Retry a failed chunk load once — against a *different URL* — then stop asking
 * (DEV-2569).
 *
 * ⚠ The load-bearing browser rule, and the reason this is not a plain "call it again":
 * **a failed module fetch is cached in the module map for the life of the document, and
 * re-importing the same specifier never touches the network again.** Measured in Chromium
 * 141 (`@playwright/test` 1.61.1), routing `chunk.js` to an abort and then serving it:
 *
 *   attempt 1  ./chunk.js            -> TypeError            1 request
 *   attempt 2  ./chunk.js            -> same TypeError       1 request  (no refetch)
 *   attempt 3  ./chunk.js, now 200   -> same TypeError       1 request  (still no refetch)
 *   attempt 4  ./chunk.js?retry=1    -> module               2 requests
 *
 * So evicting our own memo (`createLazyLoader`) is necessary but on its own inert: the
 * retry has to ask for a URL the module map has never seen. `retryOf` builds that URL from
 * the failed error's own message — the only place the resolved chunk URL exists at runtime,
 * since the specifier is rewritten to a hashed path at build time — and returns null when
 * the engine named no URL, in which case the first failure is already terminal.
 *
 * `generation` is what makes *Restart preview* honest rather than a button that reruns a
 * decided failure: each `rearm` mints a fresh query, so the visitor's retry is a real
 * request. A rotated-out chunk fails again immediately (the busted URL 404s to the same
 * HTML), which is what leaves the reload as the only cure for that case, while a blip that
 * has since passed now genuinely recovers — without a reload, and without losing unsaved
 * edits.
 *
 * Bounded on purpose: two requests per page, plus two per explicit click. Nothing in the
 * code path retries on its own, so a stranded tab cannot spend the visitor's bandwidth or
 * file an event per keystroke.
 */
export function createRetryingLoader<T>(
  load: () => Promise<T>,
  retryOf: (cause: unknown, generation: number) => Promise<T> | null,
  wrap: (cause: unknown, opts: { replay?: boolean }) => Error,
): { load: () => Promise<T>; rearm: () => void } {
  let terminal: Error | null = null;
  let generation = 0;
  return {
    load: async () => {
      // Re-thrown, not re-wrapped, so `replay` marks it: the shell has already reported
      // and carded this failure, and every later keystroke arrives here.
      if (terminal) throw wrap((terminal as Error).cause, { replay: true });
      let first: unknown;
      try {
        return await load();
      } catch (cause) {
        first = cause;
      }
      const retry = retryOf(first, generation);
      if (retry) {
        try {
          return await retry;
        } catch (cause) {
          first = cause;
        }
      }
      terminal = wrap(first, {});
      throw terminal;
    },
    rearm: () => {
      terminal = null;
      generation += 1;
    },
  };
}

/**
 * Resolve the babel object out of whatever a dynamic import actually handed back
 * (DEV-2569, second pass).
 *
 * The two import sites in this file are byte-identical in source and *not* identical in the
 * shipped bundle. Vite rewrites only the bare specifier, and `@babel/standalone` is CJS, so
 * the primary site gets an interop hop the `@vite-ignore` retry does not. Measured in the
 * deployed bundle (`/assets/index-uxATgr1X.js`, 2026-08-20):
 *
 *   primary:  import("./babel-<hash>.js").then(t => t.b).then(t => t.default ?? t)
 *   retry:    import(`${url}?hotRetry=1`).then(o => o.default ?? o)
 *
 * and the chunk's only export is that wrapper — `export { Hke as b }`, where `Hke` is Vite's
 * `_mergeNamespaces({__proto__: null, default: babel}, [cjs])`. So the retry resolved the raw
 * module record `{b: {…}}`, `m.default` was `undefined`, and the loader returned the record:
 * the retry "succeeded" and the next compile died as `e.transform is not a function`.
 *
 * Hence a shape check rather than a fixed unwrap. The three shapes this has to accept, all
 * measured:
 *
 *   Node / `dist` (what `pipeline/*.test.mjs` sees)   { default: babel, …named }
 *   bundled primary, after Vite's hop                 { __proto__: null, default: babel }
 *   bundled retry, no hop                             { b: { default: babel, transform } }
 *
 * `default` is preferred at every level, so the primary path keeps resolving exactly the
 * object it resolves today. Walking *values* rather than a hardcoded `b` is what survives
 * Rollup renaming that export — the name is bundler-generated and pinned by nothing.
 *
 * A miss **throws**, and the throw carries the URL: this runs inside the loaders, so the
 * rejection reaches `createRetryingLoader` and becomes a `CompilerUnavailableError` — latched,
 * carded, and reported as our own infrastructure failure. Left un-thrown it would surface
 * downstream inside `babel.transform` and be filed in the visitor-source Sentry bucket as if
 * it were the visitor's typo, which is the other half of what this defect was. `assetUrl` is
 * recovered by `assetUrlFrom` regexing the cause's *message*, so the URL has to be in it.
 */
export function asBabel(ns: unknown, url?: string | null): Babel {
  const babel = findBabel(ns, 2);
  if (babel) return babel;
  throw new TypeError(
    `the in-browser compiler module exported no transform()${url ? `: ${url}` : ""}`,
  );
}

/** Depth 2 is what the shapes above need: the record, its `default`, and one wrapper level. */
function findBabel(value: unknown, depth: number): Babel | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  const record = value as Record<string, unknown>;
  if (depth > 0) {
    const viaDefault = findBabel(record.default, depth - 1);
    if (viaDefault) return viaDefault;
  }
  if (typeof record.transform === "function") return record as unknown as Babel;
  if (depth > 0) {
    for (const nested of Object.values(record)) {
      const hit = findBabel(nested, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

const loadBabelChunk = createLazyLoader<Babel>(() =>
  import("@babel/standalone").then((m) => asBabel(m)),
);

/** The retry's URL: the failed chunk with a query the module map has not seen. `@vite-ignore`
 *  because the specifier is only known at runtime — it comes out of the browser's own error
 *  message — and Vite must not try to resolve or pre-bundle it. */
function retryBabelChunk(cause: unknown, generation: number): Promise<Babel> | null {
  const url = assetUrlFrom(cause);
  if (!url) return null;
  const sep = url.includes("?") ? "&" : "?";
  const spec = `${url}${sep}hotRetry=${generation + 1}`;
  return import(/* @vite-ignore */ spec).then((m) => asBabel(m, spec));
}

const babelLoader = createRetryingLoader<Babel>(
  loadBabelChunk,
  retryBabelChunk,
  (cause, opts) => new CompilerUnavailableError(cause, opts),
);

const loadBabel = babelLoader.load;

/**
 * Allow one more compiler-chunk attempt after the loader has given up.
 *
 * Called from *Restart preview* in the authoring app and from nowhere else: the point of
 * the latch is that no code path retries by itself, and the point of this is that a
 * visitor whose network came back does not have to reload and lose their edits. The next
 * retry URL carries a fresh query, so it is a real request rather than a module-map replay
 * — see `createRetryingLoader`.
 */
export function rearmCompilerLoad(): void {
  babelLoader.rearm();
}

const SOURCE_RE = /\.(tsx|ts|jsx|js)$/;

/**
 * Compile a plain-JS dependency dist down to the babel 6 parse floor (used by
 * dep-shims.ts for packages whose published dist uses post-ES2017 syntax).
 * `sourceType: "unambiguous"` keeps UMD bundles in script mode so their
 * top-level `this` survives, while ESM dists keep their import/export syntax.
 */
export async function transpileDependencyDist(code: string, filename: string): Promise<string> {
  const babel = await loadBabel();
  const compiled = babel.transform(code, {
    filename,
    presets: [["env", { targets: TARGETS, modules: false, include: ["transform-classes"] }]],
    sourceType: "unambiguous",
    sourceMaps: false,
    babelrc: false,
    configFile: false,
    // Dependency dists can be hundreds of KB; compact output keeps the
    // recompile that follows (babel 6 in the bundler) cheap.
    compact: true,
  }).code;
  if (!compiled) throw new Error(`transpiling ${filename} produced no output`);
  return compiled;
}

/** Chrome 58 ≈ ES2017 without object rest/spread — the babel 6.26 parse floor. */
const TARGETS = { chrome: "58" };

// JSX factory identifiers injected into compiled output. Modern docs examples
// never `import React` (they're written for the automatic JSX runtime), so
// classic-runtime output calling `React.createElement` would throw "React is
// not defined" at render. Compile JSX to a private pragma instead and prepend
// its own `react` import whenever the output uses it.
const JSX_PRAGMA = "__hotJsx";
const JSX_PRAGMA_FRAG = "__hotJsxFrag";
const JSX_IMPORT = `import { createElement as ${JSX_PRAGMA}, Fragment as ${JSX_PRAGMA_FRAG} } from "react";\n`;

function presetsFor(path: string): unknown[] {
  // `modules: false` keeps ES module syntax: parcel resolves `import` itself,
  // and converting to CJS is unnecessary churn in the produced code.
  //
  // `transform-classes` is force-included even though the target supports
  // classes: if any `class` reaches the bundler, babel 6 downlevels it to an
  // ES5 constructor whose `Parent.call(this)` throws when the parent is a
  // native ES6 class from a dependency dist (hyperformula's FunctionPlugin).
  // Babel 8's transform goes through Reflect.construct, which native parents
  // accept — and babel 6 then sees no `class` at all.
  const presets: unknown[] = [
    ["env", { targets: TARGETS, modules: false, include: ["transform-classes"] }],
  ];
  if (/\.tsx?$/.test(path)) presets.push("typescript");
  // Classic runtime: the classic bundler predates the automatic runtime's
  // `react/jsx-runtime` subpath import. The pragma keeps it self-contained.
  if (/\.(tsx|jsx)$/.test(path)) {
    presets.push(["react", { runtime: "classic", pragma: JSX_PRAGMA, pragmaFrag: JSX_PRAGMA_FRAG }]);
  }
  return presets;
}

/**
 * Compile all `.tsx`/`.ts`/`.jsx`/`.js` files in the map to babel-6-parseable
 * JavaScript. TS/JSX sources are renamed to `.js`, and references to renamed
 * files inside `.html` files (script tags) are rewritten to match.
 */
export async function transpileFilesForParcel(files: FilesMap): Promise<FilesMap> {
  const babel = await loadBabel();
  const out: FilesMap = {};
  const renamed: Array<[string, string]> = [];

  for (const [path, code] of Object.entries(files)) {
    // `.d.ts` files are type-only (nothing imports them at runtime) — pass
    // them through rather than stripping them to an empty renamed module.
    if (!SOURCE_RE.test(path) || path.endsWith(".d.ts")) {
      out[path] = code;
      continue;
    }
    let compiled: string;
    try {
      compiled = babel.transform(code, {
        filename: path,
        presets: presetsFor(path),
        // Docs examples are small; skip source maps and compact renderers.
        sourceMaps: false,
        babelrc: false,
        configFile: false,
      }).code ?? "";
    } catch (e) {
      throw new Error(`Failed to transpile ${path} for the parcel sandbox: ${(e as Error).message}`);
    }
    if (compiled.includes(JSX_PRAGMA)) compiled = JSX_IMPORT + compiled;
    const jsPath = path.replace(SOURCE_RE, ".js");
    if (jsPath !== path) renamed.push([path, jsPath]);
    out[jsPath] = compiled;
  }

  const renamedMap = new Map(renamed);

  for (const [path, code] of Object.entries(out)) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".html")) out[path] = rewriteHtml(code, renamedMap, out);
    else if (lower.endsWith(".js")) out[path] = rewriteSpecifiers(path, code, renamedMap);
  }

  return out;
}

// Import/export specifier positions: `from "…"`, bare `import "…"`, dynamic
// `import("…")` and `require("…")`. The bare form is the one the vanilla-TS docs
// wrapper emits, so a `from`-only pattern would miss the actual breakage.
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

/** Resolve a relative specifier against the importing file to a files-map key. */
function resolveSpecifier(fromPath: string, spec: string): string {
  const segments: string[] = [];
  for (const seg of [...fromPath.split("/").slice(0, -1), ...spec.split("/")]) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { segments.pop(); continue; }
    segments.push(seg);
  }
  return "/" + segments.join("/");
}

/**
 * Repoint relative specifiers that name a renamed source by its authored
 * extension (`import "../index.ts"` — what wrap-docs-example.mjs emits for the
 * TypeScript variant) at the compiled `.js` file. Renaming the file without
 * this makes the parcel resolver hard-fail the sandbox with "Could not find
 * module in path: '../index.ts' relative to '/src/main.js'" (DEV-2175).
 * Specifiers not in `renamed` — bare packages, CSS, already-`.js` targets —
 * are left exactly as authored.
 */
function rewriteSpecifiers(path: string, code: string, renamed: Map<string, string>): string {
  return code.replace(SPECIFIER_RE, (full, prefix: string, quote: string, spec: string) => {
    if (!SOURCE_RE.test(spec)) return full;
    if (!renamed.has(resolveSpecifier(path, spec))) return full;
    return `${prefix}${quote}${spec.replace(SOURCE_RE, ".js")}${quote}`;
  });
}

/**
 * The parcel environment resolves every local URL in the HTML entry as a
 * module and hard-fails the sandbox on a miss. Rewrite src/href attributes
 * that point at renamed (compiled) sources, and drop `<link>` tags whose
 * local target does not exist in the sandbox (e.g. a /favicon.svg that the
 * starter never ships).
 */
function rewriteHtml(html: string, renamed: Map<string, string>, files: FilesMap): string {
  const mapped = html.replace(
    /\b(src|href)=(["'])([^"']+)\2/gi,
    (full, attr: string, quote: string, value: string) => {
      const key = toFilesKey(value);
      if (key === null) return full;
      const to = renamed.get(key);
      if (to === undefined) return full;
      // Preserve the author's path style (bare / ./-relative / absolute).
      const rewritten = value.startsWith("/") ? to : value.startsWith("./") ? `.${to}` : to.slice(1);
      return `${attr}=${quote}${rewritten}${quote}`;
    },
  );

  return mapped.replace(/<link\b[^>]*>\s*/gi, (tag) => {
    const href = tag.match(/\bhref=(["'])([^"']+)\1/i)?.[2];
    if (!href) return tag;
    const key = toFilesKey(href);
    if (key === null || files[key] !== undefined) return tag;
    return "";
  });
}
