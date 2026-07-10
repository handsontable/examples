// pipeline/import-docs.mjs
//
// Imports every Handsontable *documentation guide* example into the demo runner.
//
// It walks the handsontable docs repo (handsontable/docs/content/guides/**/*.md),
// parses each `::: example` directive to learn which framework source fragments
// make up an example, wraps each fragment into a full minimal runnable project
// (pipeline/wrap-docs-example.mjs — the same wrapper the docs "Edit on
// StackBlitz" button uses), and emits, under apps/authoring/public/docs-examples/:
//
//   manifest.json                      — small metadata list that drives the
//                                        breadcrumb-grouped example dropdown.
//   <encoded-docsPath>.json            — one full CatalogEntry per example,
//                                        fetched on demand when the user opens it.
//
// The runner opens an example by its docs content path, e.g.
//   /?docs=guides/columns/column-adding/javascript/example1.ts
//
// Deterministic and dependency-free (Node built-ins only).
//
// Run:  node runner/pipeline/import-docs.mjs [--docs=<path-to-handsontable/docs>]
//   env HOT_DOCS_DIR overrides the default ../../handsontable/docs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapDocsExample } from "./wrap-docs-example.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(RUNNER_DIR, "..");

function resolveDocsDir() {
  const arg = process.argv.find((a) => a.startsWith("--docs="));
  const raw = arg ? arg.slice("--docs=".length) : process.env.HOT_DOCS_DIR;
  const candidate = raw
    ? path.resolve(process.cwd(), raw)
    : path.resolve(REPO_ROOT, "..", "handsontable", "docs");
  if (!fs.existsSync(path.join(candidate, "content", "guides"))) {
    throw new Error(
      `Handsontable docs not found at ${candidate}. Pass --docs=<path> or set HOT_DOCS_DIR ` +
        `(expected a checkout of handsontable/handsontable with docs/content/guides).`,
    );
  }
  return candidate;
}

const DOCS_DIR = resolveDocsDir();
const CONTENT_DIR = path.join(DOCS_DIR, "content");
const GUIDES_DIR = path.join(CONTENT_DIR, "guides");
const OUT_DIR = path.join(RUNNER_DIR, "apps", "authoring", "public", "docs-examples");

// Handsontable version to bake into wrapped projects (the runner re-pins it at
// runtime; this is just the default + the CDN CSS URL version).
function readHotVersion() {
  // The core library package lives at <repo>/handsontable/package.json
  // (docs is <repo>/docs). Mirrors framework-loader.mjs's HOT_VERSION lookup.
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(DOCS_DIR, "..", "handsontable", "package.json"), "utf8"),
    );
    return pkg.version || "latest";
  } catch {
    return "latest";
  }
}
const HOT_VERSION = readHotVersion();

// Packages already provided by each framework scaffold — never added to extraDeps.
// Mirrors BUILTIN_PKGS in docs/src/plugins/framework-loader.mjs.
const BUILTIN_PKGS = new Set([
  "handsontable",
  "@handsontable/react-wrapper",
  "@handsontable/vue3",
  "@handsontable/angular-wrapper",
  "vue",
  "react",
  "react-dom",
  "@angular/core",
  "@angular/common",
  "@angular/compiler",
  "@angular/platform-browser",
  "@angular/platform-browser-dynamic",
  "@angular/forms",
  "@angular/animations",
  "@angular/router",
  "zone.js",
  "rxjs",
]);

// ── Runner target config per framework variant ──────────────────────────────
// Values mirror runner/config/frameworks.json, aligned to the file layout that
// wrap-docs-example.mjs emits. Tier-1 frameworks run in Sandpack (in-browser);
// Angular runs in a Cloudflare Sandbox container (the server derives its dev
// command/port from the `framework` key).
const RUNNER = {
  javascript: {
    framework: "javascript", displayName: "JavaScript", tier: 1, engine: "sandpack",
    sandpackTemplate: "vanilla", sandpackEnvironment: "parcel", container: null, htWrappers: [],
    entry: "/src/main.js", htmlEntry: "/index.html",
    devCommand: null, buildCommand: "vite build", outputDir: "dist", outputGlob: null,
    staticExport: false, spaMode: false, port: null, installCommand: "npm install",
  },
  typescript: {
    framework: "typescript", displayName: "TypeScript", tier: 1, engine: "sandpack",
    sandpackTemplate: "vanilla-ts", sandpackEnvironment: "parcel", container: null, htWrappers: [],
    entry: "/src/main.ts", htmlEntry: "/index.html",
    devCommand: null, buildCommand: "vite build", outputDir: "dist", outputGlob: null,
    staticExport: false, spaMode: false, port: null, installCommand: "npm install",
  },
  react: {
    framework: "react", displayName: "React (TS)", tier: 1, engine: "sandpack",
    sandpackTemplate: "react-ts", sandpackEnvironment: "create-react-app-typescript",
    container: null, htWrappers: ["@handsontable/react-wrapper"],
    entry: "/src/main.tsx", htmlEntry: "/index.html",
    devCommand: null, buildCommand: "vite build", outputDir: "dist", outputGlob: null,
    staticExport: false, spaMode: false, port: null, installCommand: "npm install",
  },
  "react-js": {
    framework: "react-js", displayName: "React (JS)", tier: 1, engine: "sandpack",
    sandpackTemplate: "react", sandpackEnvironment: "create-react-app",
    container: null, htWrappers: ["@handsontable/react-wrapper"],
    entry: "/src/main.jsx", htmlEntry: "/index.html",
    devCommand: null, buildCommand: "vite build", outputDir: "dist", outputGlob: null,
    staticExport: false, spaMode: false, port: null, installCommand: "npm install",
  },
  // Vue 3 docs examples use `<script setup>`, which the in-browser (classic)
  // bundler cannot compile — they run on the container engine (real Vite dev).
  vue: {
    framework: "vue", displayName: "Vue 3", tier: 2, engine: "container",
    sandpackTemplate: null, sandpackEnvironment: null, container: "vue",
    htWrappers: ["@handsontable/vue3"],
    entry: "/src/main.ts", htmlEntry: "/index.html",
    devCommand: "npx --no-install vite --host 0.0.0.0 --port 5173",
    buildCommand: "vite build", outputDir: "dist", outputGlob: null,
    staticExport: false, spaMode: false, port: 5173, installCommand: "npm install",
  },
  angular: {
    framework: "angular", displayName: "Angular", tier: 2, engine: "container",
    sandpackTemplate: null, sandpackEnvironment: null, container: "angular",
    htWrappers: ["@handsontable/angular-wrapper"],
    entry: "/src/main.ts", htmlEntry: "/src/index.html",
    devCommand: "npm run start -- --host 0.0.0.0 --disable-host-check --port 3000",
    buildCommand: "ng build", outputDir: "dist", outputGlob: "dist/*/browser",
    staticExport: false, spaMode: false, port: 3000, installCommand: "npm install --legacy-peer-deps",
  },
};

// ── Directive parsing ───────────────────────────────────────────────────────

const CODE_RE = /^@\[code(?:\s+[^\]]*)?\]\(@\/content\/(.+?)\)\s*$/;

/** Clean a markdown heading to plain text (strip anchors, code, links, emphasis). */
function cleanHeading(s) {
  return s
    .replace(/\{#[^}]*\}/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]/g, "")
    .replace(/#+\s*$/, "")
    .trim();
}

/**
 * Parse all `::: example` / `::: example-without-tabs` blocks in a markdown body.
 * Returns [{ exampleId, fileRefs, heading }] — fileRefs are content-relative
 * paths; heading is the nearest preceding markdown heading (H2–H6), used to
 * title the example. Framework is derived later from the fileRefs' directory
 * (robust: js examples ship a .ts variant, so a marker/extension is ambiguous).
 */
function parseExampleBlocks(md) {
  const lines = md.split("\n");
  const blocks = [];
  let cur = null;
  let depth = 0;
  let lastHeading = null;

  for (const line of lines) {
    const open = line.match(/^:::\s*(example|example-without-tabs)\s+#(\S+)/);
    if (open) {
      cur = { exampleId: open[2], fileRefs: [], heading: lastHeading };
      depth = 1;
      continue;
    }
    if (cur) {
      if (/^:{3,}\s*\S/.test(line)) { depth++; continue; } // nested opener
      if (/^:{3,}\s*$/.test(line)) {
        depth--;
        if (depth <= 0) { blocks.push(cur); cur = null; }
        continue;
      }
      const m = line.match(CODE_RE);
      if (m) cur.fileRefs.push(m[1].trim());
    } else {
      const h = line.match(/^(#{2,6})\s+(.+?)\s*$/);
      if (h) lastHeading = cleanHeading(h[2]) || null;
    }
  }
  return blocks;
}

/**
 * Compute a display title per exampleId within one guide:
 *   - example1 → "Standard example"
 *   - otherwise → the nearest preceding heading (or "Example N" fallback)
 * Titles are de-duplicated within a guide by appending a counter.
 */
function computeTitles(blocks) {
  const byId = new Map(); // exampleId -> heading (first seen)
  for (const b of blocks) if (!byId.has(b.exampleId)) byId.set(b.exampleId, b.heading);

  const titles = new Map();
  const used = new Map();
  for (const [id, heading] of byId) {
    let title;
    if (/^example0*1$/i.test(id)) {
      title = "Standard example";
    } else {
      const n = id.match(/(\d+)/);
      title = heading || (n ? `Example ${n[1]}` : id);
    }
    const seen = used.get(title) || 0;
    used.set(title, seen + 1);
    if (seen > 0) title = `${title} (${seen + 1})`;
    titles.set(id, title);
  }
  return titles;
}

/** Framework folder → runner base framework. */
function detectFramework(fileRefs) {
  if (fileRefs.some((r) => /\/angular\//.test(r))) return "angular";
  if (fileRefs.some((r) => /\/react\//.test(r))) return "react";
  if (fileRefs.some((r) => /\/vue(?:3)?\//.test(r))) return "vue";
  return "javascript";
}

/** Runnable variants to emit for a block, given its framework + available refs. */
function variantsFor(framework, fileRefs) {
  const has = (ext) => fileRefs.find((r) => r.endsWith(ext));
  const out = [];
  if (framework === "javascript") {
    if (has(".js")) out.push({ runner: "javascript", scriptExt: ".js" });
    if (has(".ts")) out.push({ runner: "typescript", scriptExt: ".ts" });
  } else if (framework === "react") {
    // Emit the TypeScript (.tsx) variant only — the React Sandpack environment
    // renders it reliably, while the plain `.jsx` classic-bundler path is blank.
    if (has(".tsx")) out.push({ runner: "react", scriptExt: ".tsx", wrap: "react" });
    else if (has(".jsx")) out.push({ runner: "react", scriptExt: ".jsx", wrap: "react" });
  } else if (framework === "vue") {
    if (has(".vue")) out.push({ runner: "vue", scriptExt: ".vue", wrap: "vue" });
  } else if (framework === "angular") {
    if (has(".ts")) out.push({ runner: "angular", scriptExt: ".ts", wrap: "angular" });
  }
  return out;
}

const WRAP_FRAMEWORK = { javascript: "javascript", typescript: "javascript", react: "react", "react-js": "react", vue: "vue", angular: "angular" };
const COMPANION_EXT = new Set([".html", ".css"]);

function readRef(ref) {
  try {
    return fs.readFileSync(path.join(CONTENT_DIR, ref), "utf8").replace(/\r\n/g, "\n").trimEnd();
  } catch {
    return null;
  }
}

/** Extract extra (non-builtin) npm package imports from source code. */
function collectExtraDeps(codeStrings) {
  const deps = {};
  for (const code of codeStrings) {
    for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const imp = m[1];
      if (imp.startsWith(".") || imp.startsWith("/")) continue;
      const pkg = imp.startsWith("@") ? imp.split("/").slice(0, 2).join("/") : imp.split("/")[0];
      if (!BUILTIN_PKGS.has(pkg) && !pkg.startsWith("handsontable/")) deps[pkg] = "latest";
    }
  }
  return deps;
}

// ── Breadcrumb / title helpers ──────────────────────────────────────────────

function titleCase(seg) {
  return seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function frontmatterField(md, field) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const t = m[1].match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!t) return null;
  return t[1].trim().replace(/^["']|["']$/g, "");
}

function frontmatterTitle(md) {
  return frontmatterField(md, "title");
}

/** Breadcrumb from the guide dir path under guides/, e.g.
 *  columns/column-adding → ["Columns", "Column adding"]. Leaf uses fm title. */
function breadcrumbFor(guideRelDir, guideTitle) {
  const segs = guideRelDir.split("/").filter(Boolean);
  const crumbs = segs.map(titleCase);
  if (guideTitle && crumbs.length) crumbs[crumbs.length - 1] = guideTitle;
  // Collapse consecutive duplicate crumbs (docs often nest a guide in a
  // same-named folder, e.g. accessibility/accessibility).
  return crumbs.filter((c, i) => i === 0 || c.toLowerCase() !== crumbs[i - 1].toLowerCase());
}

// ── Encoding ────────────────────────────────────────────────────────────────

/** docsPath → artifact filename (filesystem + URL safe). */
function encodePath(docsPath) {
  return docsPath.replace(/\//g, "__") + ".json";
}

// ── Main ────────────────────────────────────────────────────────────────────

function walkMd(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkMd(full, acc);
    else if (name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function main() {
  const mdFiles = walkMd(GUIDES_DIR);
  const manifest = [];
  const problems = [];
  let written = 0;
  const seen = new Set();

  // Reset output dir.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const mdPath of mdFiles) {
    const md = fs.readFileSync(mdPath, "utf8");
    const blocks = parseExampleBlocks(md);
    if (!blocks.length) continue;

    const guideRelDir = path.relative(GUIDES_DIR, path.dirname(mdPath)).split(path.sep).join("/");
    const guideTitle = frontmatterTitle(md);
    const crumbs = breadcrumbFor(guideRelDir, guideTitle);
    const guideRel = path.relative(CONTENT_DIR, mdPath).split(path.sep).join("/");
    const titles = computeTitles(blocks); // exampleId -> display title
    // Docs page permalink (e.g. "/column-adding"); fall back to the guide folder.
    const permalink = frontmatterField(md, "permalink") ||
      "/" + (guideRelDir.split("/").pop() || guideRelDir);

    for (const block of blocks) {
      const framework = detectFramework(block.fileRefs);
      const variants = variantsFor(framework, block.fileRefs);
      if (!variants.length) continue; // server-side (php/py) or no runnable entry

      // Gather ref contents once.
      const refContent = {};
      for (const ref of block.fileRefs) {
        const c = readRef(ref);
        if (c !== null) refContent[ref] = c;
      }

      for (const variant of variants) {
        const scriptRef = block.fileRefs.find((r) => r.endsWith(variant.scriptExt) && refContent[r] !== undefined);
        if (!scriptRef) continue;
        const docsPath = scriptRef; // content-relative, includes framework folder + ext

        if (seen.has(docsPath)) continue;
        seen.add(docsPath);

        // Build userFiles: the chosen script + shared companions (html/css).
        const userFiles = {};
        userFiles[path.basename(scriptRef)] = refContent[scriptRef];
        for (const ref of block.fileRefs) {
          if (ref === scriptRef) continue;
          const ext = path.extname(ref).toLowerCase();
          if (COMPANION_EXT.has(ext) && refContent[ref] !== undefined) {
            userFiles[path.basename(ref)] = refContent[ref];
          }
        }

        const cfg = RUNNER[variant.runner];
        const extraDeps = collectExtraDeps(Object.values(userFiles));
        const wrapped = wrapDocsExample({
          framework: WRAP_FRAMEWORK[variant.runner],
          hotVersion: HOT_VERSION,
          exampleId: block.exampleId,
          userFiles,
          extraDeps,
        });

        // Re-key to leading-slash paths for the runner FilesMap.
        const files = {};
        for (const [k, v] of Object.entries(wrapped)) files["/" + k] = v;

        if (!files["/package.json"]) { problems.push(`${docsPath}: no package.json`); continue; }
        if (!files[cfg.entry] && !files[cfg.htmlEntry ?? ""]) {
          problems.push(`${docsPath}: entry ${cfg.entry} / ${cfg.htmlEntry} missing`);
        }

        const exampleTitle = titles.get(block.exampleId) || block.exampleId;
        const displayName = `${crumbs.join(" ▸ ")} · ${exampleTitle} · ${cfg.displayName}`;
        const entry = {
          ...cfg,
          displayName,
          htCoreRange: HOT_VERSION,
          fileCount: Object.keys(files).length,
          assets: [],
          skipped: [],
          files,
          // docs metadata
          docsPath,
          breadcrumb: crumbs,
          guide: guideRel,
          guideTitle: guideTitle || crumbs[crumbs.length - 1] || guideRelDir,
          exampleId: block.exampleId,
          exampleTitle,
          docPermalink: permalink,
          lang: cfg.displayName,
        };

        fs.writeFileSync(path.join(OUT_DIR, encodePath(docsPath)), JSON.stringify(entry) + "\n");
        written++;

        manifest.push({
          docsPath,
          file: encodePath(docsPath),
          breadcrumb: crumbs,
          guide: guideRel,
          guideTitle: entry.guideTitle,
          exampleId: block.exampleId,
          exampleTitle,
          docPermalink: permalink,
          framework: cfg.framework,
          displayName: cfg.displayName,
        });
      }
    }
  }

  // Sort manifest by breadcrumb path then exampleId then framework for a stable,
  // grouped dropdown order.
  manifest.sort((a, b) => {
    const ka = a.breadcrumb.join("/") + "|" + a.exampleId + "|" + a.framework;
    const kb = b.breadcrumb.join("/") + "|" + b.exampleId + "|" + b.framework;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      { generatedFrom: "handsontable/docs content/guides/**", hotVersion: HOT_VERSION, count: manifest.length, examples: manifest },
      null,
      2,
    ) + "\n",
  );

  console.log(`[import-docs] docs dir: ${DOCS_DIR}`);
  console.log(`[import-docs] handsontable version: ${HOT_VERSION}`);
  console.log(`[import-docs] wrote ${written} example artifacts + manifest.json → ${path.relative(REPO_ROOT, OUT_DIR)}`);
  const byFw = {};
  for (const e of manifest) byFw[e.framework] = (byFw[e.framework] || 0) + 1;
  console.log(`[import-docs] by framework:`, byFw);
  console.log(`[import-docs] guide groups: ${new Set(manifest.map((e) => e.breadcrumb.join(" ▸ "))).size}`);
  if (problems.length) {
    console.error(`[import-docs] ${problems.length} problems:\n  - ` + problems.slice(0, 30).join("\n  - "));
    if (problems.length > 30) console.error(`  … and ${problems.length - 30} more`);
    process.exitCode = 1;
  }
}

main();
