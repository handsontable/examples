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
  const hasJs = !!jsPanel?.trim();
  const files: Record<string, string> = {
    // Only reference the files that are actually written: a fiddle with an empty
    // CSS or JS panel would otherwise get a <link>/<script> pointing at a file
    // that does not exist, which the bundler reports as a failed module.
    "/index.html": wrapFiddleHtml(htmlPanel ?? "", title, sourceUrl, { hasCss, hasJs }),
  };
  if (hasCss) files["/style.css"] = cssPanel!;
  if (hasJs) files["/script.js"] = jsPanel!;
  // No dependencies to install: a fiddle runs off CDN tags. The manifest exists
  // because every workspace needs one — `POST /api/demos` rejects a file set
  // without /package.json, and the builder installs from it.
  files["/package.json"] = `${JSON.stringify(
    {
      name: "imported-fiddle",
      private: true,
      version: "0.0.0",
      scripts: { dev: "vite --port 8080", build: "vite build", preview: "vite preview" },
      devDependencies: { vite: "^8.1.1" },
    },
    null,
    2,
  )}\n`;

  return { title, files, skipped: [] };
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

  return { title: store.project?.title?.trim() || "Imported StackBlitz project", files, skipped };
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
