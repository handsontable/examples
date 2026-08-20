#!/usr/bin/env node
// The compiler chunk must keep a hash-free path and stay lazily loaded (DEV-2569).
//
// Two build-shaped promises no unit test can see, both of which failed in production once:
//
//  1. `@babel/standalone` ships in its own chunk named `assets/compiler-babel.js`, with no
//     content hash. `apps/authoring/wrangler.jsonc` serves this app from Workers Assets with
//     `not_found_handling: "single-page-application"`, so a deploy removes the previous
//     build's hashed chunks and their paths answer `200 text/html` instead of a 404. A tab
//     that had not yet fetched the ~2.3 MB compiler when a deploy landed was asking for a
//     file that no longer existed — forever, since an HTML body is not a module (Sentry
//     DEMOS-15). The rename is a one-line `chunkFileNames` in `vite.config.ts`, and it rests
//     on Rollup's implicit chunk name for the dynamic import in
//     `packages/runtime/src/transpile.ts`. If a Rollup version renames that chunk, the hash
//     comes back silently — this is what makes it loud instead.
//
//  2. It stays *dynamically* imported. Naming it via `manualChunks` was measured to pull
//     Rollup's shared `getDefaultExportFromCjs` helper into the same chunk, which made two
//     ordinary chunks import 2.3 MB of compiler statically and put a `modulepreload` for it
//     in index.html. Every visitor would have paid for a compiler that only Tier-1 examples
//     use, and nothing else in the suite would have noticed.
//
// Run against a real `vite build` output — the `authoring` job in ci.yml does, right after
// building it.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/authoring/dist");
const CHUNK = "compiler-babel.js";

if (!existsSync(dist)) {
  console.error(`no build to check at ${dist} — run \`pnpm --filter @handsontable/demo-authoring build\` first`);
  process.exit(1);
}

const failures = [];
const assetsDir = path.join(dist, "assets");
// Guarded like `dist` itself: a half-cleaned build would otherwise crash with a raw ENOENT
// stack in place of the message this script exists to print.
if (!existsSync(assetsDir)) {
  console.error(`${assetsDir} does not exist — the build did not finish`);
  process.exit(1);
}
const assets = readdirSync(assetsDir);

if (!assets.includes(CHUNK)) {
  const hashed = assets.filter((f) => /^(compiler-)?babel-.*\.js$/.test(f));
  failures.push(
    `assets/${CHUNK} is missing${hashed.length ? ` — found ${hashed.join(", ")} instead, so the chunk was renamed and \`chunkFileNames\` in vite.config.ts no longer matches it` : ""}`,
  );
}

const html = readFileSync(path.join(dist, "index.html"), "utf8");
if (html.includes(CHUNK)) {
  failures.push(`index.html references ${CHUNK} (a preload or a script tag) — the compiler must not be part of the initial load`);
}

const dynamic = [];
for (const file of assets.filter((f) => f.endsWith(".js") && f !== CHUNK)) {
  const code = readFileSync(path.join(assetsDir, file), "utf8");
  // A static `import … from "./compiler-babel.js"` is the failure mode: it makes the chunk
  // eager even though the source only ever writes `import(…)`.
  if (/\bfrom\s*["']\.\/compiler-babel\.js["']/.test(code)) {
    failures.push(`assets/${file} imports ${CHUNK} statically — the chunk is no longer lazy`);
  }
  if (code.includes(`import("./${CHUNK}")`)) dynamic.push(file);
}

if (dynamic.length !== 1) {
  failures.push(
    `expected exactly one chunk to dynamically import ${CHUNK}, found ${dynamic.length}${dynamic.length ? ` (${dynamic.join(", ")})` : " — the lazy load is gone"}`,
  );
}

if (failures.length) {
  console.error("compiler chunk check failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`compiler chunk ok: assets/${CHUNK}, lazily imported by ${dynamic[0]} only`);
