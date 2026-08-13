// Importing a demo from JSFiddle or StackBlitz (DEV-2504).
//
// Runs in the Worker, not the browser, for two reasons: neither origin sends
// CORS headers, and a user-supplied URL being fetched server-side is SSRF
// surface that wants one gate, in one place (see `resolveSource`).
//
// Neither provider offers a documented read API for this, so both parsers read a
// payload the page happens to serve today:
//
//   JSFiddle    — the editor page server-renders all three panels into
//                 <textarea name="code_html|code_css|code_js">, HTML-escaped.
//   StackBlitz  — the editor page embeds the whole project as JSON in
//                 <script type="application/json" data-redux-store="">, under
//                 `project.appFiles`. `/api/projects/:slug` looks like the right
//                 endpoint and is not: it returns metadata only, no contents.
//
// Both are pinned by fixture tests (pipeline/import-url.test.mjs) recorded from
// real projects, so a format change fails in CI instead of in front of a user.
// When one does change, `ImportError` is what the user sees — a sentence naming
// the manual route, never a stack trace.

/** What the caller gets back: a workspace, plus where it came from. */
export interface ImportResult {
  provider: "jsfiddle" | "stackblitz";
  title: string;
  files: Record<string, string>;
  /** Framework key for BUILD_CONFIG / the catalog, resolved from the files. */
  framework: string;
  /** Paths dropped on the way in, with the reason — surfaced, never silent. */
  skipped: { path: string; reason: string }[];
}

/** An import that failed for a reason the user can act on. */
export class ImportError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ImportError";
    this.status = status;
  }
}

/** Ceilings. The StackBlitz editor page is ~2.5 MB of JSON, so the response cap
 *  cannot be tight; the per-file and per-project caps are the ones that keep a
 *  runaway import out of D1 and out of a builder container. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024; // matches the starter importer's MAX_TEXT_BYTES
const MAX_FILES = 80;
const FETCH_TIMEOUT_MS = 15_000;

/** Text-only, for the same reason drag & drop is (ADR-0031): a workspace is
 *  Record<string, string> from here down to the builder. */
const TEXT_EXTENSIONS = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro",
  "html", "htm", "css", "scss", "sass", "less", "svg",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "csv", "tsv",
  "md", "mdx", "txt", "graphql", "gql",
]);

const TEXT_FILENAMES = new Set([
  "README", "LICENSE", "CHANGELOG", "Dockerfile",
  ".gitignore", ".npmrc", ".nvmrc", ".editorconfig", ".prettierrc", ".browserslistrc",
]);

/** Directories whose contents are never worth importing. */
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".cache", "dist", "build", "out",
  ".next", ".nuxt", ".output", ".astro", ".angular", ".vite", ".vscode", ".idea",
]);

/** Lockfiles are re-resolved by the builder; a `.env` may hold real credentials
 *  and a demo is one Save away from a public /d/:id. */
const EXCLUDE_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", ".DS_Store",
]);
const SECRET_FILE_RE = /(^|\/)\.env(\..+)?$/i;

function isTextPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (TEXT_FILENAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * `a/b.ts` -> `/a/b.ts`, or null if the provider handed us something that must
 * not become a workspace key.
 *
 * The paths come from the imported project, and they end up composed with the
 * builder container's root (`CONTAINER_ROOT + path` in share.ts) when a demo is
 * saved. A crafted project carrying `../../etc/x` would write outside the project
 * root, so traversal is rejected rather than normalized away — a path that needed
 * rewriting to be safe is not a path we should be importing at all.
 */
function workspacePath(raw: string): string | null {
  const segments = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((segment) => segment === "." || segment === ".." )) return null;
  // A drive letter or a UNC-ish leading segment has no meaning here either.
  if (/^[A-Za-z]:$/.test(segments[0]!)) return null;
  return `/${segments.join("/")}`;
}

/**
 * Decide which provider a URL belongs to and what to fetch for it.
 *
 * This is the SSRF gate: an exact host allowlist (no suffix matching — a
 * `jsfiddle.net.evil.com` must not pass), https only, and a rewritten URL rather
 * than the user's own, so nothing but a provider page is ever requested.
 */
export function resolveSource(input: string): { provider: ImportResult["provider"]; url: string } {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new ImportError("That does not look like a URL.");
  }
  if (parsed.protocol !== "https:") throw new ImportError("Only https:// URLs can be imported.");

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "jsfiddle.net") {
    // /:slug/:version?/ , /:user/:slug/:version?/. A shared URL often carries a
    // viewer suffix — /show, /embedded/js,html,css/ — and everything from that
    // segment on describes the *viewer*, not the fiddle, so the path is cut
    // there rather than filtered segment by segment (the panel list arrives as
    // one comma-joined segment, which a filter would keep).
    const all = parsed.pathname.split("/").filter(Boolean);
    const viewer = all.findIndex((s) => ["embedded", "embed", "show"].includes(s));
    const segments = viewer === -1 ? all : all.slice(0, viewer);
    if (!segments.length) throw new ImportError("That JSFiddle URL has no fiddle in it.");
    return { provider: "jsfiddle", url: `https://jsfiddle.net/${segments.join("/")}/` };
  }

  if (host === "stackblitz.com") {
    const segments = parsed.pathname.split("/").filter(Boolean);
    // /edit/:slug, /~/:slug, and the github-backed /github/owner/repo (which
    // serves the same editor page).
    const slug = segments[0] === "edit" || segments[0] === "~" ? segments[1] : null;
    if (segments[0] === "github") {
      return { provider: "stackblitz", url: `https://stackblitz.com/${segments.join("/")}` };
    }
    if (!slug) throw new ImportError("Use the StackBlitz project URL, e.g. https://stackblitz.com/edit/<id>.");
    return { provider: "stackblitz", url: `https://stackblitz.com/edit/${slug}` };
  }

  if (host === "codesandbox.io") {
    // Not a gap we can close from here: /api/v1/sandboxes/:id answers 403 behind
    // a Cloudflare bot challenge, and the /p/devbox page is a client-rendered
    // shell with no files in it. Defeating that check is not on the table, so say
    // what does work instead.
    throw new ImportError(
      "CodeSandbox blocks automated reads of its projects. Export the sandbox to a .zip " +
        "(File → Export to ZIP), unpack it, and drag the files onto the FILES panel instead.",
    );
  }

  throw new ImportError(`Importing from ${host} is not supported — JSFiddle and StackBlitz are.`);
}

// ---- JSFiddle ---------------------------------------------------------------

/** Minimal HTML-entity decode for textarea contents (`&lt;` … and numerics). */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Ampersand last, or `&amp;lt;` would decode twice into `<`.
    .replace(/&amp;/g, "&");
}

function panel(html: string, name: "html" | "css" | "js"): string | null {
  const match = new RegExp(
    `<textarea[^>]*name="code_${name}"[^>]*>([\\s\\S]*?)</textarea>`,
    "i",
  ).exec(html);
  return match ? decodeEntities(match[1]!) : null;
}

function pageTitle(html: string): string | null {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  // "Grid demo - JSFiddle - Code Playground" -> "Grid demo"
  const text = decodeEntities(match[1]!).trim();
  const cut = text.split(/\s+[-–—]\s+/)[0]!.trim();
  return cut || null;
}

/**
 * A fiddle is three panels, not a project: it has no package.json, no entry
 * module, and its HTML panel is a *fragment* (JSFiddle wraps it in a document at
 * run time). So the import wraps it the same way — one `index.html` that hosts
 * the fragment and references the two sibling files.
 *
 * The panels keep whatever CDN `<link>`/`<script>` tags the author wrote in the
 * HTML panel, which is how a fiddle usually pulls Handsontable in; nothing here
 * tries to convert those into npm dependencies.
 */
export function parseJsFiddle(html: string, sourceUrl: string): Omit<ImportResult, "provider" | "framework"> {
  const htmlPanel = panel(html, "html");
  const cssPanel = panel(html, "css");
  const jsPanel = panel(html, "js");

  if (htmlPanel === null && cssPanel === null && jsPanel === null) {
    throw new ImportError(
      "Could not read that fiddle's panels — JSFiddle may have changed its page, or the " +
        "fiddle is private. Copy the HTML/CSS/JS across by hand for now.",
      502,
    );
  }
  if (!htmlPanel?.trim() && !jsPanel?.trim()) {
    throw new ImportError("That fiddle has no HTML and no JavaScript to import.");
  }

  const title = pageTitle(html) ?? "Imported fiddle";
  const hasCss = !!cssPanel?.trim();

  // A fiddle's libraries arrive as CDN <script> tags and its code calls them as
  // globals, which a module bundler cannot resolve (DEV-2509). Convert before
  // wrapping, so the tags are gone from the HTML and the imports are in the JS.
  const normalized = normalizeCdnGlobals(htmlPanel ?? "", jsPanel ?? "");

  // Not `!!jsPanel?.trim()` (found in review, HIGH): an HTML-only fiddle whose
  // libraries came from CDN tags now *needs* a module — the tags are gone and the
  // preamble that replaced them is the only thing that loads them. Without this it
  // got neither.
  const hasJs = !!normalized.js.trim();

  const files: Record<string, string> = {
    // Only reference the files that are actually written: a fiddle with an empty
    // CSS or JS panel would otherwise get a <link>/<script> pointing at a file
    // that does not exist, which the bundler reports as a failed module.
    "/index.html": wrapFiddleHtml(normalized.html, title, sourceUrl, { hasCss, hasJs }),
  };
  if (hasCss) files["/style.css"] = cssPanel!;
  if (hasJs) files["/script.js"] = normalized.js;
  // No dependencies to install: a fiddle runs off CDN tags. The manifest exists
  // because every workspace needs one — `POST /api/demos` rejects a file set
  // without /package.json, and the builder installs from it.
  files["/package.json"] = `${JSON.stringify(
    {
      name: "imported-fiddle",
      private: true,
      version: "0.0.0",
      scripts: { dev: "vite --port 8080", build: "vite build", preview: "vite preview" },
      // What the CDN tags became. `handsontable` is re-pinned to the selected
      // version at mount (`applyHandsontableVersion`), which is the point of
      // converting the unversioned CDN URL in the first place.
      ...(Object.keys(normalized.dependencies).length
        ? { dependencies: sortedDependencies(normalized.dependencies) }
        : {}),
      devDependencies: { vite: "^8.1.1" },
    },
    null,
    2,
  )}\n`;

  return { title, files, skipped: normalized.skipped };
}

/** Host the fiddle's HTML fragment in a real document. */
function wrapFiddleHtml(
  fragment: string,
  title: string,
  sourceUrl: string,
  { hasCss, hasJs }: { hasCss: boolean; hasJs: boolean },
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title.replace(/[<>&]/g, "")}</title>
    <!-- Imported from ${sourceUrl} -->
${hasCss ? '    <link rel="stylesheet" href="./style.css" />\n' : ""}  </head>
  <body>
${fragment.replace(/^/gm, "    ").replace(/\s+$/, "")}
${hasJs ? '    <script type="module" src="./script.js"></script>\n' : ""}  </body>
</html>
`;
}

// ---- StackBlitz -------------------------------------------------------------

interface StackBlitzEntry {
  name?: string;
  type?: string;
  contents?: string;
  fullPath?: string;
}

/**
 * Read `project.appFiles` out of the editor page's Redux snapshot.
 *
 * The snapshot holds folders as entries too (`type: "folder"`), and it holds
 * whatever the author left in the project — `dist/`, a lockfile — so the
 * exclusions above do real work here, not just defensive work.
 */
export function parseStackBlitz(html: string): Omit<ImportResult, "provider" | "framework"> {
  const match = /<script type="application\/json" data-redux-store="">([\s\S]*?)<\/script>/i.exec(html);
  if (!match) {
    throw new ImportError(
      "Could not read that StackBlitz project — the page format changed, or the project is " +
        "private. Use StackBlitz's Download button and drag the files onto the FILES panel.",
      502,
    );
  }

  let store: { project?: { appFiles?: Record<string, StackBlitzEntry>; title?: string } };
  try {
    store = JSON.parse(match[1]!);
  } catch {
    throw new ImportError("That StackBlitz page carried a payload we could not parse.", 502);
  }

  const appFiles = store.project?.appFiles;
  if (!appFiles || typeof appFiles !== "object") {
    throw new ImportError(
      "That StackBlitz project exposes no files. Private projects and Bolt apps cannot be " +
        "imported — use Download and drag the files in instead.",
      502,
    );
  }

  const files: Record<string, string> = {};
  const skipped: { path: string; reason: string }[] = [];

  for (const [key, entry] of Object.entries(appFiles)) {
    if (entry?.type !== "file") continue; // folder rows carry no contents
    const raw = entry.fullPath ?? key;
    const path = workspacePath(raw);
    if (path === null) {
      // Reported, not silently dropped: a project whose paths cannot be trusted
      // is something the author should hear about.
      skipped.push({ path: raw, reason: "unsafe path" });
      continue;
    }
    const segments = path.slice(1).split("/");
    const name = segments[segments.length - 1]!;

    if (segments.slice(0, -1).some((dir) => EXCLUDE_DIRS.has(dir))) continue;
    if (EXCLUDE_FILES.has(name)) continue;
    if (SECRET_FILE_RE.test(raw)) {
      skipped.push({ path, reason: "environment file" });
      continue;
    }
    if (!isTextPath(path)) {
      skipped.push({ path, reason: "not a text file" });
      continue;
    }
    const contents = entry.contents ?? "";
    if (contents.length > MAX_FILE_BYTES) {
      skipped.push({ path, reason: `larger than ${Math.floor(MAX_FILE_BYTES / 1024)} KB` });
      continue;
    }
    if (Object.keys(files).length >= MAX_FILES) {
      skipped.push({ path, reason: `over the ${MAX_FILES}-file limit` });
      continue;
    }
    files[path] = contents.replace(/\r\n/g, "\n");
  }

  if (!Object.keys(files).length) {
    throw new ImportError("That StackBlitz project has no importable text files.");
  }
  if (!files["/package.json"]) {
    throw new ImportError(
      "That StackBlitz project has no package.json, so it cannot be built here. Add one there, " +
        "or import it as files by hand.",
    );
  }

  // Usually a no-op — a StackBlitz project imports from npm already — but one that
  // pulls Handsontable from a CDN tag in index.html breaks the same way a fiddle
  // does, so it gets the same conversion (DEV-2509).
  normalizeStackBlitzEntry(files, skipped);

  return { title: store.project?.title?.trim() || "Imported StackBlitz project", files, skipped };
}

// ---- CDN globals -> npm imports (DEV-2509) ----------------------------------
//
// A fiddle gets its libraries from `<script src="https://cdn…">` and calls them as
// globals. The Tier-1 preview is a module bundler: it resolves `import` against
// package.json, and a CDN tag in the HTML body never defines a global in the
// bundled module scope. Copying the panels verbatim produced a workspace that
// could not run — `ReferenceError: Handsontable is not defined`.
//
// So the import converts: drop the tag, add the dependency, and import the package
// under the same identifier the global had, so the author's code is untouched.
//
// This lives in this file rather than its own module on purpose: the pipeline
// tests load it through `--experimental-strip-types`, which cannot resolve a
// sibling `./x.js` specifier — the same constraint that keeps `profile.ts` and
// `demos-list.ts` dependency-free.

/** How a package that used to be a global is imported. */
interface CdnPackage {
  /** npm package name, as it goes into `dependencies`. */
  pkg: string;
  /** What to import — usually the package, sometimes a subpath entry. */
  specifier?: string;
  /** The identifier the UMD build put on `window`. */
  global: string;
  /** `default` -> `import X from`, `named` -> `import { X } from`,
   *  `namespace` -> `import * as X from`. */
  kind: "default" | "named" | "namespace";
}

/**
 * The libraries fiddles actually load next to Handsontable. Keyed by npm package
 * name, which is what both jsDelivr and unpkg put in the path.
 *
 * `chart.js/auto` rather than `chart.js`: the UMD build auto-registers every
 * controller, and the bare npm entry does not — importing that would give a chart
 * that throws about an unregistered type, which is a worse outcome than the tag we
 * removed.
 */
const CDN_PACKAGES: Record<string, CdnPackage> = {
  handsontable: { pkg: "handsontable", global: "Handsontable", kind: "default" },
  "@handsontable/pikaday": { pkg: "@handsontable/pikaday", global: "Pikaday", kind: "default" },
  hyperformula: { pkg: "hyperformula", global: "HyperFormula", kind: "named" },
  "highlight.js": { pkg: "highlight.js", global: "hljs", kind: "default" },
  xlsx: { pkg: "xlsx", global: "XLSX", kind: "namespace" },
  "chart.js": { pkg: "chart.js", specifier: "chart.js/auto", global: "Chart", kind: "default" },
  moment: { pkg: "moment", global: "moment", kind: "default" },
  pikaday: { pkg: "pikaday", global: "Pikaday", kind: "default" },
  papaparse: { pkg: "papaparse", global: "Papa", kind: "default" },
  jquery: { pkg: "jquery", global: "$", kind: "default" },
  luxon: { pkg: "luxon", global: "luxon", kind: "namespace" },
};

export interface NormalizedImport {
  html: string;
  js: string;
  /** Added to `package.json` dependencies. */
  dependencies: Record<string, string>;
  /** What could not be converted, in the shape the import result reports. */
  skipped: { path: string; reason: string }[];
}

/** `https://cdn.jsdelivr.net/npm/pkg@1.2/dist/x.js` -> `{ pkg, range }`. */
export function packageFromCdnUrl(url: string): { name: string; range: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  let spec: string | null = null;
  if (host === "cdn.jsdelivr.net" && segments[0] === "npm") {
    spec = segments[1] ?? null;
    // A scoped package spans two segments: /npm/@scope/name@1.2/…
    if (spec?.startsWith("@") && segments[2]) spec = `${spec}/${segments[2]}`;
  } else if (host === "unpkg.com") {
    spec = segments[0] ?? null;
    if (spec?.startsWith("@") && segments[1]) spec = `${spec}/${segments[1]}`;
  } else if (host === "cdnjs.cloudflare.com" && segments[0] === "ajax" && segments[1] === "libs") {
    // /ajax/libs/<name>/<version>/…  — the library name here is cdnjs's, which
    // matches npm for everything in the table above.
    return segments[2] ? { name: segments[2], range: segments[3] ?? null } : null;
  } else if (host === "cdn.skypack.dev" || host === "esm.sh") {
    spec = segments[0] ?? null;
    if (spec?.startsWith("@") && segments[1]) spec = `${spec}/${segments[1]}`;
  }
  if (!spec) return null;

  // Split the version off the last segment, leaving a leading @scope alone.
  const at = spec.lastIndexOf("@");
  if (at > 0) return { name: spec.slice(0, at), range: spec.slice(at + 1) || null };
  return { name: spec, range: null };
}

/**
 * A CDN range -> something npm can install. `11` -> `^11`; `0.18.5` stays exact.
 *
 * Allowlisted, not sanitized: this string comes out of a URL path the importer was
 * handed, and it lands in a `package.json` that a builder container runs
 * `pnpm install` against. npm accepts far more than a version there —
 * `npm:other-pkg`, `file:…`, `git+ssh://…`, a tarball URL — so a crafted
 * `…/npm/handsontable@npm:evil-pkg/dist/x.js` would have installed an attacker's
 * package inside our build (found in review, HIGH). Anything that is not plainly a
 * semver fragment degrades to `latest`, which is what an unversioned URL gets
 * anyway.
 */
const SEMVER_FRAGMENT_RE = /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function dependencyRange(range: string | null): string {
  if (!range || !SEMVER_FRAGMENT_RE.test(range)) return "latest";
  const version = range.replace(/^v/, "");
  // A partial version is a range; a full one is a pin.
  return /^\d+(\.\d+)?$/.test(version) ? `^${version}` : version;
}

function importLine(entry: CdnPackage): string {
  const from = entry.specifier ?? entry.pkg;
  switch (entry.kind) {
    case "named":
      return `import { ${entry.global} } from '${from}';`;
    case "namespace":
      return `import * as ${entry.global} from '${from}';`;
    default:
      return `import ${entry.global} from '${from}';`;
  }
}

/** Every `<script src="…">` / `<link href="…">` with an absolute URL. */
const TAG_RE = /<(script|link)\b[^>]*?\b(?:src|href)="(https?:\/\/[^"]+)"[^>]*>(?:\s*<\/script>)?/gi;

/** Handsontable's own stylesheets, which become npm imports so the demo follows
 *  the selected version instead of `latest`. */
const HOT_CSS_RE = /\/(handsontable(?:@[^/]+)?)\/styles\/([A-Za-z0-9.-]+\.css)/;

/**
 * Convert an imported HTML + JS pair into something the runner can actually run.
 *
 * `usedIdentifier` decides whether an import is worth adding: a fiddle that loads
 * jQuery and never calls it should not gain a dependency, and an unused import of
 * a UMD-only package is a bundler error waiting to happen.
 */
export function normalizeCdnGlobals(html: string, js: string): NormalizedImport {
  const dependencies: Record<string, string> = {};
  const skipped: { path: string; reason: string }[] = [];
  const imports: string[] = [];
  const globals: string[] = [];
  const cssImports: string[] = [];

  const usedIdentifier = (name: string): boolean => {
    // Word-boundary on both sides, so `$` and `moment` do not match inside
    // `$element` or `momentum`. `$` needs its own test: `\b` means nothing next
    // to a symbol.
    const pattern = name === "$"
      ? /(^|[^A-Za-z0-9_$])\$\s*\(/
      : new RegExp(`(^|[^A-Za-z0-9_$.])${name}\\b`);
    return pattern.test(js) || pattern.test(html);
  };

  const nextHtml = html.replace(TAG_RE, (tag, kind: string, url: string) => {
    const isScript = kind.toLowerCase() === "script";

    // Handsontable CSS -> an npm import of the same file.
    const hotCss = !isScript && HOT_CSS_RE.exec(url);
    if (hotCss) {
      cssImports.push(`import 'handsontable/styles/${hotCss[2]}';`);
      return "";
    }
    // Any other stylesheet is left alone: a CDN <link> loads fine and pins
    // nothing that the version picker cares about.
    if (!isScript) return tag;

    const found = packageFromCdnUrl(url);
    const entry = found ? CDN_PACKAGES[found.name] : undefined;
    if (!found || !entry) {
      skipped.push({
        path: url,
        reason: "external script kept as-is; it may not run in the preview",
      });
      return tag;
    }
    if (!usedIdentifier(entry.global)) {
      // Loaded but never called. Drop the tag and say so rather than adding a
      // dependency nothing imports.
      skipped.push({ path: url, reason: `unused (${entry.global} is never referenced)` });
      return "";
    }
    dependencies[entry.pkg] = dependencyRange(found.range);
    imports.push(importLine(entry));
    globals.push(entry.global);
    return "";
  });

  if (!imports.length && !cssImports.length) return { html, js, dependencies, skipped };

  // Skip only what the source *already* imports, line by line.
  //
  // The first version skipped the entire preamble whenever the JS contained any
  // `import` at all (found in review, HIGH): the CDN tags were still stripped from
  // the HTML, so a fiddle with one import of its own lost the Handsontable CSS and
  // every converted global — the exact failure this change exists to fix,
  // reintroduced for a subset of fiddles.
  const newImports = imports.filter((line) => !alreadyImports(js, line));
  const newCss = cssImports.filter((line) => !alreadyImports(js, line));

  // An inline `<script>` (no `type="module"`) runs while the document parses; the
  // entry module is deferred, so these assignments land *after* it. They are here
  // for code that runs later — an inline handler, a timeout — and the note below
  // covers the case they cannot help.
  for (const name of globals.filter((global) => inlineScriptUses(html, global))) {
    skipped.push({
      path: `inline <script> using ${name}`,
      reason:
        `${name} is a module import now, so an inline script in the HTML cannot see it ` +
        "— move that code into the JS panel",
    });
  }

  const preamble = [
    "// Imported from a CDN-based demo (DEV-2509): the <script> tags became real",
    "// imports so the bundler can resolve them. The globalThis assignments expose",
    "// the same names to code that runs after this module — an inline handler, a",
    "// timeout — but not to an inline script that runs while the page parses.",
    ...newImports,
    ...newCss,
    ...globals.map((name) => `globalThis.${name} = ${name};`),
    "",
    "",
  ].join("\n");

  return {
    html: tidyBlankLines(nextHtml),
    js: preamble + js,
    dependencies,
    skipped,
  };
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Is this import line's specifier already imported by the source? */
function alreadyImports(js: string, line: string): boolean {
  const found = /from '([^']+)'|^import '([^']+)'/.exec(line);
  const specifier = found?.[1] ?? found?.[2];
  if (!specifier) return false;
  const quoted = escapeForRegExp(specifier);
  return new RegExp(`(?:from|import)\\s*['"]${quoted}['"]`).test(js);
}

/** Does a *classic* inline script reference this identifier? Those run while the
 *  document parses, before the deferred entry module, so a converted global
 *  cannot reach them. */
function inlineScriptUses(html: string, name: string): boolean {
  const pattern = name === "$"
    ? /(^|[^A-Za-z0-9_$])\$\s*\(/
    : new RegExp(`(^|[^A-Za-z0-9_$.])${escapeForRegExp(name)}\\b`);
  for (const match of html.matchAll(/<script(?![^>]*\btype="module")[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (pattern.test(match[1] ?? "")) return true;
  }
  return false;
}

/** Removing tags leaves runs of blank lines where they were. */
function tidyBlankLines(html: string): string {
  return html.replace(/([ \t]*\n){3,}/g, "\n\n");
}


/** Deterministic dependency order, so two imports of the same fiddle produce the
 *  same package.json (and the same fingerprint downstream). */
function sortedDependencies(deps: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Convert CDN tags inside a StackBlitz project's HTML entry, merging whatever
 * dependencies that produces into its existing package.json.
 *
 * Mutates `files` because that is what the caller holds; the alternative is
 * rebuilding the whole map to change two entries.
 */
function normalizeStackBlitzEntry(
  files: Record<string, string>,
  skipped: { path: string; reason: string }[],
): void {
  const htmlPath = Object.keys(files).find((path) => /(^|\/)index\.html$/.test(path));
  if (!htmlPath) return;

  // The module the HTML entry points at — that is where a preamble belongs. With
  // no obvious entry there is nothing to convert into, so the tags stay.
  // A *local* module only: `src="https://cdn…/handsontable.full.min.js"` also ends
  // in `.js`, and matching it first made the lookup below fail and the whole
  // conversion bail — with the CDN tags left in place (found in review). Libraries
  // usually come before the app entry, so this was the common case, not the corner.
  const entryMatch = /<script[^>]*\bsrc="(?!https?:|\/\/)([^"]+\.(?:m?[jt]sx?))"/i.exec(
    files[htmlPath]!,
  );
  const entryPath = entryMatch
    ? Object.keys(files).find((path) => path.endsWith(entryMatch[1]!.replace(/^\.?\//, "")))
    : undefined;
  if (!entryPath) return;

  const normalized = normalizeCdnGlobals(files[htmlPath]!, files[entryPath]!);
  if (!Object.keys(normalized.dependencies).length && normalized.html === files[htmlPath]) return;

  files[htmlPath] = normalized.html;
  files[entryPath] = normalized.js;
  skipped.push(...normalized.skipped);

  try {
    const pkg = JSON.parse(files["/package.json"]!) as { dependencies?: Record<string, string> };
    // The project's own pins win: it declared them deliberately, and the CDN URL's
    // range is a guess derived from a path.
    pkg.dependencies = sortedDependencies({ ...normalized.dependencies, ...pkg.dependencies });
    files["/package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;
  } catch {
    // A manifest we cannot parse is one we must not rewrite.
  }
}

// ---- the Handsontable-only rule ---------------------------------------------

/**
 * Ways a project can legitimately use Handsontable. A demo runner for
 * Handsontable hosts Handsontable demos; anything else is someone else's app
 * running on our build minutes and our share links.
 *
 * Checked against the *files*, not the URL or the title: the whole point is that
 * a project claiming to be a grid demo has to actually pull the library in.
 */
const HOT_PACKAGE_RE = /^(handsontable|@handsontable\/.+)$/;

/** `import … from "handsontable/..."`, `require("@handsontable/react-wrapper")`,
 *  a CDN <script>/<link>, or the constructor the UMD build exposes. */
const HOT_SOURCE_RE = new RegExp(
  [
    // a module specifier, however it is written
    String.raw`(?:from|require|import)\s*\(?\s*["'](?:handsontable|@handsontable/)`,
    // a bare side-effect import or a CSS @import
    String.raw`@?import\s+["'](?:handsontable|@handsontable/)`,
    // the CDNs a fiddle actually uses
    String.raw`(?:cdn\.jsdelivr\.net/npm|unpkg\.com|cdnjs\.cloudflare\.com/ajax/libs)/(?:handsontable|@handsontable)`,
    // and the global itself
    String.raw`\bnew\s+Handsontable\s*\(`,
    String.raw`\bHandsontable\.[A-Za-z_$]`,
  ].join("|"),
);

/** Does this file set use Handsontable at all? */
export function usesHandsontable(files: Record<string, string>): boolean {
  const manifest = files["/package.json"];
  if (manifest) {
    try {
      const pkg = JSON.parse(manifest) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const names = Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      });
      if (names.some((name) => HOT_PACKAGE_RE.test(name))) return true;
    } catch {
      // A manifest we cannot read decides nothing; the sources still can.
    }
  }
  // A fiddle has no dependencies at all — its Handsontable comes from a CDN tag
  // or a bare `new Handsontable(...)`, so the sources are the only evidence.
  return Object.entries(files).some(
    ([path, contents]) => path !== "/package.json" && HOT_SOURCE_RE.test(contents),
  );
}

/** Refuse a project that does not use Handsontable, saying why. */
export function assertHandsontableProject(files: Record<string, string>): void {
  if (usesHandsontable(files)) return;
  throw new ImportError(
    "That project does not use Handsontable, and this playground only hosts Handsontable demos. " +
      "Add handsontable as a dependency (or a CDN script tag) there, then import it again.",
  );
}

// ---- framework detection ----------------------------------------------------

/** dependency name -> catalog framework key, most specific first. */
const FRAMEWORK_BY_DEPENDENCY: [string, string][] = [
  ["next", "next.js"],
  ["nuxt", "nuxt"],
  ["@remix-run/react", "remix"],
  ["astro", "astro"],
  ["@angular/core", "angular"],
  ["vue", "vue"],
  ["react", "react"],
];

/**
 * Which starter shape the imported files behave like.
 *
 * `known` is the catalog's framework list, passed in rather than imported so this
 * module stays free of the generated config (and so a test can pin the mapping).
 * An unknown match degrades to the closest vanilla starter instead of failing the
 * import: the author can switch the framework afterwards, but cannot get their
 * code back out of a rejected import.
 */
export function detectFramework(files: Record<string, string>, known: Set<string>): string {
  const raw = files["/package.json"];
  const typescript = Object.keys(files).some((p) => /\.tsx?$/.test(p));
  const vanilla = typescript && known.has("typescript") ? "typescript" : "javascript";

  if (!raw) return vanilla;
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return vanilla;
  }

  for (const [dependency, framework] of FRAMEWORK_BY_DEPENDENCY) {
    if (!deps[dependency] || !known.has(framework)) continue;
    // React has both a TS and a JS starter; pick by what the files actually are.
    if (framework === "react" && !typescript && known.has("react-js")) return "react-js";
    return framework;
  }
  return vanilla;
}

// ---- the fetch --------------------------------------------------------------

/** Providers normalize their own URLs (jsfiddle sends /:slug -> /:slug/1/), so
 *  redirects have to be followed — but each hop is re-checked, not trusted. */
const MAX_REDIRECTS = 3;

async function fetchPage(url: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    let target = url;
    for (let hop = 0; ; hop++) {
      response = await fetchImpl(target, {
        // Manual, so the allowlist survives the hop. Letting fetch follow
        // redirects implicitly would widen the SSRF boundary from
        // "provider pages" to "wherever a provider points us", which is the
        // whole boundary this module exists to hold.
        redirect: "manual",
        headers: {
          // Both pages serve a different (JS-only) shell to a bare bot UA.
          "User-Agent": "Mozilla/5.0 (compatible; HandsontableDemos/1.0; +https://demos.handsontable.com)",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new ImportError("That page redirected to nowhere.", 502);
      if (hop >= MAX_REDIRECTS) throw new ImportError("That page redirected too many times.", 502);
      // Relative Locations are normal (jsfiddle's own normalization is one), so
      // resolve against the current target and re-run the host gate on the
      // result. `resolveSource` throws for anything off-allowlist.
      const next = new URL(location, target).toString();
      resolveSource(next);
      target = next;
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    const aborted = (error as Error)?.name === "AbortError";
    throw new ImportError(
      aborted ? "That page took too long to answer." : "Could not reach that URL.",
      504,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) throw new ImportError("That project does not exist, or is private.", 404);
  if (!response.ok) throw new ImportError(`That page answered ${response.status}.`, 502);

  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new ImportError("That page is too large to import.", 413);

  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new ImportError("That page is too large to import.", 413);
  return text;
}

/** Fetch and parse one provider URL into a workspace. */
export async function importFromUrl(
  input: string,
  options: { knownFrameworks: Set<string>; fetchImpl?: typeof fetch },
): Promise<ImportResult> {
  const { provider, url } = resolveSource(input);
  const html = await fetchPage(url, options.fetchImpl ?? fetch);
  const parsed = provider === "jsfiddle" ? parseJsFiddle(html, url) : parseStackBlitz(html);
  // The gate lives here, not inside each parser, so both providers answer the
  // same way and a future entry point (the MCP push, DEV-2501) can reuse it.
  assertHandsontableProject(parsed.files);
  return {
    provider,
    ...parsed,
    framework: detectFramework(parsed.files, options.knownFrameworks),
  };
}
