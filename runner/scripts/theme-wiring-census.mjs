// How often does the Style panel fail to find where a demo builds its grid?
//
// The panel writes the theme module either way, but when it cannot recognise
// the construction it leaves the source alone and shows the import line for the
// reader to add. That is the right call for one odd file and the wrong shape
// for a whole framework, and nobody had counted (DEV-2197).
//
// `buildThemeChanges` already answers it: `linked: false` is the miss. This is
// a report, not a gate — run it, read it, act on what it says.
//
// Usage: node scripts/theme-wiring-census.mjs [bucket]

import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bucket = process.argv[2] ?? "18.0";
const artifacts = join(root, "apps/authoring/public/docs-examples", bucket);

// codegen.ts imports its siblings by `.js` specifier, which plain node will not
// resolve from a `.ts` file — copy the directory and rewrite them, the same way
// pipeline/theme-wiring.test.mjs does.
const dir = mkdtempSync(join(tmpdir(), "hot-census-"));
try {
  cpSync(join(root, "apps/authoring/src/theme"), join(dir, "theme"), { recursive: true });
  for (const file of readdirSync(join(dir, "theme"))) {
    if (!file.endsWith(".ts")) continue;
    const path = join(dir, "theme", file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll('.js"', '.ts"'));
  }

  writeFileSync(join(dir, "run.mjs"), `
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const { buildThemeChanges } = await import("./theme/codegen.ts");
const { DEFAULT_THEME } = await import("./theme/vocabulary.ts");

const artifacts = ${JSON.stringify(artifacts)};
const catalog = JSON.parse(readFileSync(${JSON.stringify(join(root, "catalog.json"))}, "utf8"));

const rows = [];
const survey = (name, framework, files) => {
  const { linked } = buildThemeChanges({ ...files }, DEFAULT_THEME);
  rows.push({ name, framework: framework ?? "?", linked });
};

for (const example of catalog.examples) {
  survey("starter:" + example.framework, example.framework, example.files);
}
for (const file of readdirSync(artifacts)) {
  if (!file.endsWith(".json")) continue;
  const artifact = JSON.parse(readFileSync(join(artifacts, file), "utf8"));
  // manifest.json sits in the same directory and is not an example.
  if (!artifact.framework || !artifact.files) continue;
  survey(file.replace(/\\.json$/, ""), artifact.framework, artifact.files);
}
console.log(JSON.stringify(rows));
`);

  const rows = JSON.parse(
    execFileSync(process.execPath, ["--experimental-strip-types", join(dir, "run.mjs")], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim().split("\n").at(-1),
  );

  const byFramework = new Map();
  for (const row of rows) {
    const entry = byFramework.get(row.framework) ?? { linked: 0, unlinked: 0, misses: [] };
    if (row.linked) entry.linked += 1;
    else {
      entry.unlinked += 1;
      entry.misses.push(row.name);
    }
    byFramework.set(row.framework, entry);
  }

  const total = rows.length;
  const missed = rows.filter((r) => !r.linked).length;
  console.log(`bucket ${bucket} — ${total} examples, ${total - missed} wired, ${missed} left alone\n`);

  const width = Math.max(...[...byFramework.keys()].map((k) => k.length));
  for (const [framework, entry] of [...byFramework].sort((a, b) => b[1].unlinked - a[1].unlinked)) {
    const share = entry.unlinked / (entry.linked + entry.unlinked);
    console.log(
      `${framework.padEnd(width)}  wired ${String(entry.linked).padStart(4)}`
      + `   left alone ${String(entry.unlinked).padStart(4)}`
      + `  (${(share * 100).toFixed(1)}%)`,
    );
  }

  const misses = [...byFramework.values()].flatMap((e) => e.misses);
  if (misses.length > 0) {
    console.log(`\nleft alone (first 20 of ${misses.length}):`);
    for (const name of misses.slice(0, 20)) console.log(`  ${name}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
