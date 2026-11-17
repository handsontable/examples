// A link to a themed demo has to open with the sender's theme in the panel
// (DEV-4070). The panel's state lives in the visitor's localStorage, so the
// generated module carries a copy of it and the recipient's panel adopts that
// copy. These tests pin down the round trip, and that a module edited by hand —
// or crafted, since the files are whatever the link pointed at — cannot slip a
// preset name into the import paths the next regeneration writes.
//
// Same harness as theme-wiring.test.mjs: codegen.ts imports siblings by `.js`
// specifier, so the tree is copied with the specifiers rewritten and run in a
// child process with type stripping.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(body) {
  const dir = mkdtempSync(join(tmpdir(), "hot-theme-state-"));
  try {
    cpSync(join(root, "apps/authoring/src/theme"), join(dir, "theme"), { recursive: true });
    symlinkSync(join(root, "apps/authoring/node_modules"), join(dir, "node_modules"), "dir");
    for (const file of readdirSync(join(dir, "theme"))) {
      if (!file.endsWith(".ts")) continue;
      const path = join(dir, "theme", file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll('.js"', '.ts"'));
    }
    writeFileSync(join(dir, "run.mjs"), [
      'import * as codegen from "./theme/codegen.ts";',
      'import * as vocabulary from "./theme/vocabulary.ts";',
      `const out = await (async () => { ${body} })();`,
      "process.stdout.write(JSON.stringify(out));",
    ].join("\n"));
    return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", join(dir, "run.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STATE = {
  tokens: "horizon",
  colors: "ant",
  icons: "horizon",
  colorScheme: "dark",
  density: "compact",
  params: { fontFamily: "Playfair Display", borderRadius: "6px" },
  palette: { "primary.500": "#0b5d1e" },
  densitySizes: { compact: { gap: "2" } },
};

test("the module a theme generates gives that theme back", () => {
  const out = run(`
    const files = { "/src/index.tsx": "<HotTable data={data} />" };
    const { changes } = codegen.buildThemeChanges(files, ${JSON.stringify(STATE)});
    for (const c of changes) files[c.path] = c.contents;
    return codegen.readEmbeddedThemeState(files);
  `);
  assert.deepEqual(out, STATE);
});

test("a demo with no theme module, or a reset one, carries no state", () => {
  const out = run(`
    const files = { "/src/index.tsx": "<HotTable data={data} />" };
    const before = codegen.readEmbeddedThemeState(files);
    for (const c of codegen.buildThemeChanges(files, ${JSON.stringify(STATE)}).changes) files[c.path] = c.contents;
    for (const c of codegen.buildResetChanges(files)) files[c.path] = c.contents;
    return { before, after: codegen.readEmbeddedThemeState(files) };
  `);
  assert.deepEqual(out, { before: null, after: null });
});

test("a preset name outside the known lists is not adopted", () => {
  const out = run(`
    const evil = "main'; alert(1); //";
    const marker = "// @hot-runner-theme-state ";
    const module = (s) => ({ "/handsontable-theme.js": marker + JSON.stringify(s) + "\\n" });
    return [
      codegen.readEmbeddedThemeState(module({ ...vocabulary.DEFAULT_THEME, tokens: evil })),
      codegen.readEmbeddedThemeState(module({ ...vocabulary.DEFAULT_THEME, colors: evil })),
      codegen.readEmbeddedThemeState(module({ ...vocabulary.DEFAULT_THEME, params: { x: { y: 1 } } })),
      codegen.readEmbeddedThemeState(module({ ...vocabulary.DEFAULT_THEME, densitySizes: { huge: { gap: "1" } } })),
      codegen.readEmbeddedThemeState({ "/handsontable-theme.js": marker + "{not json" }),
      codegen.readEmbeddedThemeState(module({ ...vocabulary.DEFAULT_THEME, icons: evil })),
      codegen.readEmbeddedThemeState(module({ ...vocabulary.DEFAULT_THEME, colors: "horizon" })).colors,
    ];
  `);
  assert.deepEqual(out, [null, null, null, null, null, null, "horizon"]);
});

test("the snippet for a real app carries no runner state", () => {
  const out = run(`return codegen.buildThemeSnippet(${JSON.stringify(STATE)}, true);`);
  assert.doesNotMatch(out, /hot-runner-theme/);
});

test("a value holding a JavaScript line terminator cannot end the comment early", () => {
  const out = run(`
    const state = { ...vocabulary.DEFAULT_THEME, params: { fontFamily: "Inter\\u2028alert(1)\\u2029x" } };
    const source = codegen.buildThemeModule(state, false, { bridge: true });
    const line = source.split("\\n").find((l) => l.startsWith("// @hot-runner-theme-state "));
    return {
      raw: /[\\u2028\\u2029]/.test(line),
      back: codegen.readEmbeddedThemeState({ "/handsontable-theme.js": source }).params.fontFamily,
    };
  `);
  assert.equal(out.raw, false);
  assert.equal(out.back, "Inter alert(1) x");
});

test("palette and token keys outside the catalogue, and unsafe values, are not adopted", () => {
  const out = run(`
    const marker = "// @hot-runner-theme-state ";
    const read = (s) => codegen.readEmbeddedThemeState({ "/handsontable-theme.js": marker + JSON.stringify(s) + "\\n" });
    const base = vocabulary.DEFAULT_THEME;
    return [
      read({ ...base, palette: { "__proto__.polluted": "yes" } }),
      read({ ...base, palette: { "primary.500": "url(//x/p)" } }),
      read({ ...base, palette: { "primary.500": "red; background: blue" } }),
      read({ ...base, params: { notAToken: "red" } }),
      read({ ...base, params: { fontFamily: "url(//x/f)" } }),
      read({ ...base, densitySizes: { compact: { notASize: "2px" } } }),
      read({ ...base, palette: { "primary.500": "#0b5d1e", white: "#fff" }, params: { fontFamily: "Inter" } }) !== null,
      ({}).polluted === undefined,
    ];
  `);
  assert.deepEqual(out, [null, null, null, null, null, null, true, true]);
});

test("building a module from a crafted palette key does not touch Object.prototype", () => {
  const out = run(`
    const state = { ...vocabulary.DEFAULT_THEME, palette: { "__proto__.polluted": "yes" } };
    codegen.buildThemeModule(state, false, { bridge: true });
    return ({}).polluted === undefined;
  `);
  assert.equal(out, true);
});
