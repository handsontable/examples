// pipeline/import.mjs
//
// Reads the 13 example directories from the source repo's `examples/` folder and
// emits `runner/catalog.json` — the starting-template catalog the authoring UI
// browses. Each entry is normalized to { framework, tier, files, entry,
// devCommand, buildCommand, ... } sourced from config/frameworks.json.
//
// Run:  node runner/pipeline/import.mjs   (from repo root)
//   or: node import.mjs                   (from runner/pipeline)
//
// Deterministic and dependency-free (Node built-ins only). Build artifacts,
// lockfiles, node_modules, CodeSandbox metadata, and binary assets are excluded;
// binary assets are recorded (path only) so a later stage can copy them verbatim.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(RUNNER_DIR, "..");
const EXAMPLES_DIR = path.join(REPO_ROOT, "examples");
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(RUNNER_DIR, "config", "frameworks.json"), "utf8"),
);
const FRAMEWORKS = CONFIG.frameworks;

// Directories never copied into a template.
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".astro",
  ".codesandbox", // CodeSandbox-specific config; we are replacing CodeSandbox
  ".devcontainer",
  ".vscode",
  ".changelog-prs-cache",
]);

// Files never copied: lockfiles are regenerated after version injection.
const EXCLUDE_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".DS_Store",
]);

// Extensions treated as binary assets (recorded, not inlined as text).
const BINARY_EXT = new Set([
  ".ico", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".webm", ".mp3", ".wav", ".pdf", ".zip",
]);

const MAX_TEXT_BYTES = 512 * 1024; // skip pathologically large text files

function walk(dir, base = dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      walk(full, base, acc);
    } else if (stat.isFile()) {
      if (EXCLUDE_FILES.has(name)) continue;
      acc.push({ rel, full, size: stat.size });
    }
  }
  return acc;
}

function looksBinary(buf) {
  // Heuristic: a NUL byte in the first 8 KB → binary.
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n");
}

function importExample(framework) {
  const cfg = FRAMEWORKS[framework];
  const dir = path.join(EXAMPLES_DIR, framework);
  if (!fs.existsSync(dir)) {
    throw new Error(`example directory not found: ${dir}`);
  }

  const files = {};
  const assets = [];
  const skipped = [];

  for (const { rel, full, size } of walk(dir)) {
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      assets.push(rel);
      continue;
    }
    if (size > MAX_TEXT_BYTES) {
      skipped.push({ path: rel, reason: `>${MAX_TEXT_BYTES}B` });
      continue;
    }
    const buf = fs.readFileSync(full);
    if (looksBinary(buf)) {
      assets.push(rel);
      continue;
    }
    files[`/${rel}`] = normalizeEol(buf.toString("utf8"));
  }

  const pkgKey = "/package.json";
  let htCoreRange = null;
  if (files[pkgKey]) {
    try {
      const deps = JSON.parse(files[pkgKey]).dependencies || {};
      htCoreRange = deps.handsontable ?? null;
    } catch {
      /* leave null; surfaced via fileCount sanity check below */
    }
  }

  return {
    framework,
    displayName: cfg.displayName,
    tier: cfg.tier,
    engine: cfg.engine ?? (cfg.tier === 2 ? "container" : "sandpack"),
    sandpackTemplate: cfg.sandpackTemplate ?? null,
    sandpackEnvironment: cfg.sandpackEnvironment ?? null,
    container: cfg.container ?? null,
    htWrappers: cfg.htWrappers,
    entry: `/${cfg.entry}`,
    htmlEntry: cfg.htmlEntry ? `/${cfg.htmlEntry}` : null,
    devCommand: cfg.devCommand,
    buildCommand: cfg.buildCommand,
    outputDir: cfg.outputDir,
    outputGlob: cfg.outputGlob ?? null,
    staticExport: cfg.staticExport ?? false,
    spaMode: cfg.spaMode ?? false,
    port: cfg.port,
    installCommand: cfg.installCommand,
    htCoreRange,
    fileCount: Object.keys(files).length,
    assets,
    skipped,
    files,
  };
}

function main() {
  const frameworks = Object.keys(FRAMEWORKS);
  const examples = frameworks.map(importExample);

  // Sanity: every example must have package.json and its declared entry file.
  const problems = [];
  for (const ex of examples) {
    if (!ex.files["/package.json"]) problems.push(`${ex.framework}: missing package.json`);
    if (!ex.files[ex.entry] && !(ex.assets || []).includes(ex.entry.slice(1))) {
      problems.push(`${ex.framework}: declared entry ${ex.entry} not found among files`);
    }
    if (ex.fileCount === 0) problems.push(`${ex.framework}: no files imported`);
  }
  if (problems.length) {
    console.error("[import] catalog validation problems:\n  - " + problems.join("\n  - "));
    process.exitCode = 1;
  }

  const catalog = {
    generatedFrom: "handsontable/examples examples/",
    supportedHandsontableMajors: [15, 16, 17, 18, 19],
    tiers: {
      "1": "client-side (Sandpack, in-browser bundler)",
      "2": "SSR/meta-framework (Cloudflare Sandbox container)",
    },
    examples,
  };

  const out = path.join(RUNNER_DIR, "catalog.json");
  fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + "\n");

  // Human-readable summary to stdout.
  const t1 = examples.filter((e) => e.tier === 1).map((e) => e.framework);
  const t2 = examples.filter((e) => e.tier === 2).map((e) => e.framework);
  console.log(`[import] wrote ${path.relative(REPO_ROOT, out)}`);
  console.log(`[import] ${examples.length} examples imported`);
  console.log(`[import] Tier 1 (${t1.length}): ${t1.join(", ")}`);
  console.log(`[import] Tier 2 (${t2.length}): ${t2.join(", ")}`);
  console.table(
    examples.map((e) => ({
      framework: e.framework,
      tier: e.tier,
      files: e.fileCount,
      assets: e.assets.length,
      htCore: e.htCoreRange,
      entry: e.entry,
    })),
  );
}

main();
