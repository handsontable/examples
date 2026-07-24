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

let babelPromise: Promise<Babel> | null = null;

function loadBabel(): Promise<Babel> {
  babelPromise ??= import("@babel/standalone").then(
    (m) => ((m as { default?: Babel }).default ?? m) as Babel,
  );
  return babelPromise;
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

  for (const [path, code] of Object.entries(out)) {
    if (!path.toLowerCase().endsWith(".html")) continue;
    out[path] = rewriteHtml(code, new Map(renamed), out);
  }

  return out;
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
