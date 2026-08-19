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

type Babel = {
  transform: (code: string, options: Record<string, unknown>) => { code?: string | null };
};

/**
 * A lazy singleton that caches the value but **not** a failure (DEMOS-15).
 *
 * The plain `promise ??= load()` form remembers a rejection for the life of the
 * page. That matters here because `load` is a network fetch of a code-split chunk:
 * it fails for the ordinary reasons a fetch does — an offline moment, a blocked
 * request, or a deploy that rotated the hashed asset name out from under a tab
 * opened before it. With the rejection cached, one such failure leaves Tier 1
 * unable to compile anything until the page is reloaded, and files a
 * "Failed to fetch dynamically imported module" per attempt.
 *
 * Concurrent callers still share one in-flight load — which is the reason to cache
 * at all, since @babel/standalone is ~3 MB. The slot is cleared from inside the
 * rejection handler, by which point the assignment has already happened.
 *
 * Exported for `pipeline/transpile-loader.test.mjs`: the real `loadBabel` cannot be
 * driven into failure from a test (the dependency is installed, so the import
 * resolves), and this retry rule is the whole of what changed.
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
 * Constant on purpose. A Sentry issue takes its title from the first event's
 * `name: message` and never revises it, so a message carrying the chunk URL — which
 * is what the browser's own TypeError carries — titles the issue after one sample
 * and keeps that title after the sample stops being representative. That is half of
 * what DEMOS-15 was. The URL rides on `assetUrl` instead, and reaches Sentry as an
 * extra.
 */
export const COMPILER_UNAVAILABLE_MESSAGE = "the in-browser compiler could not be loaded";

/** The one URL in a module-load failure message, if the engine named one. Chrome says
 *  "Failed to fetch dynamically imported module: <url>"; Safari says "Load failed" and
 *  names nothing, so a null here is an ordinary outcome, not a parse bug. */
function assetUrlFrom(cause: unknown): string | null {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /(https?:\/\/[^\s"')]+)/.exec(text)?.[1] ?? null;
}

/**
 * The compiler chunk could not be fetched, twice, and retrying is not the answer
 * (DEV-2569, Sentry DEMOS-15).
 *
 * The reason this is terminal rather than transient: `apps/authoring/wrangler.jsonc`
 * serves the app from Workers Assets with `not_found_handling:
 * "single-page-application"`, so a deploy removes the previous build's hashed chunks and
 * their paths answer `200 text/html` instead of a 404 — the same host behaviour DEV-2535
 * had to teach the docs loaders about. A tab that had not yet fetched the compiler when a
 * deploy landed is asking for a file that no longer exists, and will ask forever. The two
 * observed events name two different `babel-<hash>.js` on two different releases, and the
 * older of the two answers, measured:
 *
 *   $ curl -sI https://demos.handsontable.com/assets/babel-DtyXnKg5.js
 *   HTTP/2 200
 *   content-type: text/html
 *
 * An HTML body is not a module, so the import rejects however many times it is asked.
 *
 * Offline and blocked requests reach here too, and for them a reload is also the fix —
 * so the user-facing wording (`describeRuntimeError` in the authoring app) offers the
 * reload without asserting a deploy we cannot prove happened.
 *
 * Recognised by a marker property rather than `instanceof`, like
 * `DocsResourceMissingError`: the authoring app has to classify these without
 * importing the runtime's internals, and an `instanceof` across a bundle boundary is
 * the kind of check that silently starts returning false.
 */
export class CompilerUnavailableError extends Error {
  readonly compilerUnavailable = true;

  readonly assetUrl: string | null;

  constructor(cause: unknown) {
    super(COMPILER_UNAVAILABLE_MESSAGE, { cause });
    this.name = "CompilerUnavailableError";
    this.assetUrl = assetUrlFrom(cause);
  }
}

/** Whether an error is the terminal compiler-load failure above. */
export function isCompilerUnavailable(e: unknown): boolean {
  return e instanceof Error && (e as { compilerUnavailable?: boolean }).compilerUnavailable === true;
}

/**
 * Bound the retry `createLazyLoader` enables: at most one extra attempt, then stop
 * asking (DEV-2569).
 *
 * `createLazyLoader` alone makes every later compile re-attempt the fetch. That is
 * right for a transient failure and wrong for a rotated asset, which is the failure
 * actually observed: the second attempt would fail like the first, once per keystroke,
 * each one costing a 3 MB request and filing another Sentry event. So the first
 * rejection is retried immediately — the lazy loader has cleared its slot by then, so
 * this is a genuine refetch and not a re-await of the same rejection — and the second
 * rejection latches.
 *
 * The latch clears for nothing automatic. Nothing reaches `load` once it is set, so no
 * success could clear it, and a counter that reset itself would be unbounded retrying
 * with extra steps. `rearm` is the one exception: it is wired to the visitor pressing
 * *Restart preview*, so an explicit request buys exactly one more pair of attempts. A
 * blip that outlasted two fetches therefore does not force a reload and does not cost
 * unsaved edits, while nothing in the code path retries on its own.
 *
 * The same error object is thrown for every latched call, so Sentry's dedupe sees one
 * fault rather than one per keystroke.
 *
 * Two concurrent callers (a mount transpiles sources and dep-shims separately) cost two
 * fetches, not four: each does its own retry, but `createLazyLoader` collapses whatever
 * overlaps in flight.
 */
export function createBoundedLoader<T>(
  load: () => Promise<T>,
  wrap: (cause: unknown) => Error,
): { load: () => Promise<T>; rearm: () => void } {
  let terminal: Error | null = null;
  return {
    load: async () => {
      if (terminal) throw terminal;
      try {
        return await load();
      } catch {
        /* one transient failure is not news — retry below, and report only if that fails too */
      }
      try {
        return await load();
      } catch (cause) {
        terminal = wrap(cause);
        throw terminal;
      }
    },
    rearm: () => {
      terminal = null;
    },
  };
}

const loadBabelChunk = createLazyLoader<Babel>(() =>
  import("@babel/standalone").then((m) => ((m as { default?: Babel }).default ?? m) as Babel),
);

const babelLoader = createBoundedLoader(
  loadBabelChunk,
  (cause) => new CompilerUnavailableError(cause),
);

const loadBabel = babelLoader.load;

/**
 * Allow one more pair of compiler-chunk fetches after the loader has given up.
 *
 * Called from *Restart preview* in the authoring app and from nowhere else: the point of
 * the latch is that no code path retries by itself, and the point of this is that a
 * visitor whose network came back does not have to reload and lose their edits. A
 * rotated-out chunk fails again immediately, which is what leaves the reload as the only
 * cure for that case.
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

/** Normalize an HTML src/href value to a files-map key ("/…"), or null if external. */
function toFilesKey(value: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value)) return null; // http:, data:, protocol-relative …
  if (value.startsWith("/")) return value;
  if (value.startsWith("./")) return `/${value.slice(2)}`;
  return `/${value}`;
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
