import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BLANK_FRAMEWORKS, blankStarterFiles } from "./blank-starters.mjs";

// Vite 8 below 8.1.4 bundles es-module-lexer 2.2, which runs out of WebAssembly memory on the
// 4.5 MB pre-bundled `handsontable.js` of the `next` builds and answers it with a 500 ("invalid
// JS syntax"). The Tier-2 react-js preview and every downloaded starter run `vite` dev.
// Reads `examples/` rather than the generated buckets, like `starter-type-roots.test.mjs`.

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..", "..", "examples");
const FLOOR = [8, 1, 4];

function belowFloor(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (major !== FLOOR[0]) return false;
  return minor < FLOOR[1] || (minor === FLOOR[1] && patch < FLOOR[2]);
}

test("no starter lockfile resolves a Vite 8 older than 8.1.4", () => {
  let checked = 0;
  for (const dir of readdirSync(EXAMPLES, { withFileTypes: true })) {
    const lock = join(EXAMPLES, dir.name, "pnpm-lock.yaml");
    if (!dir.isDirectory() || !existsSync(lock)) continue;
    const versions = [...readFileSync(lock, "utf8").matchAll(/^ {2}vite@(\d+\.\d+\.\d+)[(:]/gm)].map((m) => m[1]);
    checked += versions.length;
    for (const v of versions) assert.equal(belowFloor(v), false, `examples/${dir.name}: vite@${v}`);
  }
  assert.ok(checked >= 10, `guard: expected the vite starters' lockfiles, read ${checked} vite entries`);
});

test("the blank starters ask for at least Vite 8.1.4", () => {
  for (const framework of BLANK_FRAMEWORKS) {
    const pkg = JSON.parse(blankStarterFiles(framework, { bucket: "next" })["/package.json"]);
    const spec = pkg.devDependencies.vite;
    const min = /(\d+\.\d+\.\d+)/.exec(spec)?.[1];
    assert.ok(min, `${framework}: unreadable vite range ${spec}`);
    assert.equal(belowFloor(min), false, `${framework}: vite ${spec}`);
  }
});
