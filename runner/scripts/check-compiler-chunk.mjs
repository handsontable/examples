#!/usr/bin/env node
// The compiler chunk must stay lazily loaded, and self-contained enough to be renameable
// (DEV-2569).
//
// `@babel/standalone` is ~2.3 MB and only Tier-1 examples ever compile, so Rollup's split of
// the dynamic import in `packages/runtime/src/transpile.ts` is what keeps it off the initial
// load. Two ways that has been lost or nearly lost, both measured, neither visible to any
// unit test:
//
//  1. **It went eager.** Naming the chunk via `manualChunks` pulled Rollup's shared
//     `getDefaultExportFromCjs` helper in with it (`export { … as b, … as g }`), after which
//     two ordinary chunks imported the 2.3 MB compiler *statically* and index.html gained a
//     `modulepreload` for it. `manualChunks` assigns a module to a chunk; it does not keep the
//     chunk lazy.
//
//  2. **It stopped being self-contained.** The emitted chunk opens with
//     `import { c, g } from "./index-<hash>.js"` — the content-hashed *entry*, whose top level
//     renders the app. That is why #249's hash-free `compiler-babel.js` had to be reverted: a
//     stable path with a hashed dependency drags a whole second copy of the app into an old
//     tab. The count below is a tripwire, not a ban: if it ever reaches zero the chunk can be
//     given a stable name, which is the fix DEV-2569 actually wants.
//
// Run against a real `vite build` output — ci.yml's `authoring` job and master.yml's deploy
// build both do, right after building it.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/authoring/dist");

if (!existsSync(dist)) {
  console.error(`no build to check at ${dist} — run \`pnpm --filter @handsontable/demo-authoring build\` first`);
  process.exit(1);
}

const assetsDir = path.join(dist, "assets");
// Guarded like `dist` itself: a half-cleaned build would otherwise crash with a raw ENOENT
// stack in place of the message this script exists to print.
if (!existsSync(assetsDir)) {
  console.error(`${assetsDir} does not exist — the build did not finish`);
  process.exit(1);
}

const failures = [];
const assets = readdirSync(assetsDir);

// Rollup names the chunk after the dynamically imported package's entry.
const chunk = assets.find((f) => /^babel-[^/]*\.js$/.test(f));
if (!chunk) {
  failures.push(
    `no assets/babel-<hash>.js chunk — @babel/standalone is no longer code-split, so every visitor now downloads ~2.3 MB of compiler (found: ${assets.filter((f) => f.endsWith(".js")).join(", ")})`,
  );
}

const html = readFileSync(path.join(dist, "index.html"), "utf8");
if (chunk && html.includes(chunk)) {
  failures.push(`index.html references ${chunk} (a preload or a script tag) — the compiler must not be part of the initial load`);
}

const dynamic = [];
if (chunk) {
  for (const file of assets.filter((f) => f.endsWith(".js") && f !== chunk)) {
    const code = readFileSync(path.join(assetsDir, file), "utf8");
    // Both static forms. `from "./chunk"` is the ordinary one; a bare `import"./chunk"` is what
    // Rollup emits when the importer uses none of the chunk's exports, and it makes the chunk
    // just as eager while matching no `from` pattern.
    const spec = `["']\\./${chunk.replace(/\./g, "\\.")}["']`;
    if (new RegExp(`\\bfrom\\s*${spec}`).test(code) || new RegExp(`\\bimport\\s*${spec}`).test(code)) {
      failures.push(`assets/${file} imports ${chunk} statically — the chunk is no longer lazy`);
    }
    if (code.includes(`import("./${chunk}")`)) dynamic.push(file);
  }

  if (dynamic.length !== 1) {
    failures.push(
      `expected exactly one chunk to dynamically import ${chunk}, found ${dynamic.length}${dynamic.length ? ` (${dynamic.join(", ")})` : " — the lazy load is gone"}`,
    );
  }
}

// Reported, not failed: this is the number that has to reach zero before the chunk can carry a
// stable name (see the header). Printing it keeps the reason for the hash in front of whoever
// next reads this output.
const crossBuild = chunk
  ? [...readFileSync(path.join(assetsDir, chunk), "utf8").matchAll(/from"\.\/([^"]+)"/g)].map((m) => m[1])
  : [];

if (failures.length) {
  console.error("compiler chunk check failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `compiler chunk ok: assets/${chunk}, lazily imported by ${dynamic[0]} only; ` +
    `${crossBuild.length} hashed dependency/ies (${crossBuild.join(", ") || "none"}) — must be 0 before it can be renamed`,
);
