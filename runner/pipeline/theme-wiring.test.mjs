// Applying a theme and then resetting it must return the demo to exactly how it
// arrived (DEV-2199).
//
// This one runs the real codegen rather than reading it as text, because the
// bugs it guards are behavioural:
//
//   * Reset used to delete `theme={customTheme}` without restoring the
//     `themeName` that wiring had displaced, so a demo came back *unthemed*
//     instead of back on `ht-theme-main`.
//   * Stripping `themeName` used to remove the whole line it sat on, which
//     erased single-line elements — `<HotTable data={data} themeName="…" />`
//     lost its grid entirely.
//
// codegen.ts is TypeScript importing siblings by `.js` specifier, which plain
// `node --test` won't resolve, so the module tree is copied to a temp dir with
// the specifiers rewritten and run in a child process with type stripping.
// Skipped rather than failed where that isn't supported (Node < 22.6).

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function runCodegen(script) {
  const dir = mkdtempSync(join(tmpdir(), "hot-theme-"));
  try {
    cpSync(join(root, "apps/authoring/src/theme"), join(dir, "theme"), { recursive: true });
    for (const file of readdirSync(join(dir, "theme"))) {
      if (!file.endsWith(".ts")) continue;
      const path = join(dir, "theme", file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll('.js"', '.ts"'));
    }
    writeFileSync(join(dir, "run.mjs"), script);
    return execFileSync(process.execPath, ["--experimental-strip-types", join(dir, "run.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES = {
  jsx: '<HotTable\n  data={data}\n  themeName="ht-theme-main"\n  licenseKey="x"\n/>',
  jsxOneLine: '<HotTable data={data} themeName="ht-theme-main" licenseKey="x" />',
  vanilla: "const hot = new Handsontable(el, {\n  data,\n  themeName: 'ht-theme-horizon',\n});",
  vanillaOneLine: "const hot = new Handsontable(el, { data, themeName: 'ht-theme-horizon' });",
  angular: 'gridSettings: GridSettings = {\n  data,\n  themeName: "ht-theme-classic",\n};',
  noThemeName: '<HotTable\n  data={data}\n  licenseKey="x"\n/>',
  ownTheme: "<HotTable data={data} theme={antTheme} />",
  // A `$` in the displaced value would be read as a replacement pattern if the
  // restore used `$1...` string substitution instead of a function.
  dollar: '<HotTable data={data} themeName="ht-$pecial" />',
};

const SCRIPT = `
const { buildThemeChanges, buildResetChanges, buildThemeModule } = await import("./theme/codegen.ts");
const { DEFAULT_THEME } = await import("./theme/vocabulary.ts");
const cases = ${JSON.stringify(CASES)};
const out = {};
for (const [name, original] of Object.entries(cases)) {
  const files = { "/src/index.tsx": original };
  const { changes } = buildThemeChanges(files, { ...DEFAULT_THEME, params: { accentColor: "#f00" } });
  for (const c of changes) files[c.path] = c.contents;
  const applied = files["/src/index.tsx"];
  const code = applied.split("\\n").filter((l) => !l.includes("handsontable-theme")).join("\\n");
  for (const c of buildResetChanges(files)) files[c.path] = c.contents;
  out[name] = {
    wired: code.includes("theme={customTheme}") || code.includes("theme: customTheme"),
    clash: /\\bthemeName\\s*[=:]/.test(code),
    gridIntact: code.includes("data={data}") || code.includes("data,"),
    roundTrips: files["/src/index.tsx"].trim() === original.trim(),
  };
}
// U+2028 is a JavaScript line terminator that JSON.stringify does NOT escape.
// The restore payload lives in a \`//\` comment, so a themeName carrying one
// ended the comment early and made whatever followed executable.
{
  const SEP = String.fromCharCode(0x2028);
  const payload = "ht" + SEP + "globalThis.PWNED = 1;//";
  const src = '<HotTable data={data} themeName="' + payload + '" />';
  const { changes } = buildThemeChanges({ "/src/index.tsx": src }, DEFAULT_THEME);
  out.__u2028 = changes.find((c) => c.path === "/src/index.tsx").contents;
}

out.__density = buildThemeModule(
  {
    ...DEFAULT_THEME,
    density: "compact",
    // Two variants, one of them not the selected type: both must be written.
    densitySizes: {
      compact: { gap: "sizing.size_2" },
      comfortable: { cellVertical: "sizing.size_5" },
    },
  },
  true,
);
console.log(JSON.stringify(out));
`;

let results = null;
let skip = false;
try {
  results = JSON.parse(runCodegen(SCRIPT).trim().split("\n").at(-1));
} catch (err) {
  skip = `codegen could not be executed here: ${err.message.split("\n")[0]}`;
}

const wiringCases = () => Object.entries(results).filter(([name]) => !name.startsWith("__"));

test("the theme is wired into every shape we claim to support", { skip }, () => {
  for (const [name, r] of wiringCases()) {
    assert.ok(r.wired, `${name}: theme was not handed to the grid`);
  }
});

test("a Unicode line separator cannot break out of the marker comment", { skip }, () => {
  // U+2028/U+2029 are line terminators to JavaScript but are left untouched by
  // JSON.stringify. The displaced `themeName` rides in a `//` comment, so one
  // ended the comment and turned the rest of the value into executable code in
  // a module every viewer of that demo evaluates.
  const wired = results.__u2028;
  const separator = String.fromCharCode(0x2028);
  assert.ok(!wired.includes(separator), "U+2028 must be escaped, not passed through");
  assert.match(wired, /\\u2028/, "it should appear as an escape instead");
  assert.doesNotMatch(wired, /^\s*globalThis\.PWNED/m, "the payload must stay inert string data");
});

test("density sizes are nested under the density variant", { skip }, () => {
  // ThemeDensitySizes is `{ [variant]: { [size]: value } }`. Emitting the sizes
  // flat put them a level too high and Handsontable ignored them in silence, so
  // density overrides never reached the grid.
  const mod = results.__density;
  assert.match(mod, /sizes: \{\s*"compact": \{\s*"gap": "sizing\.size_2",/);
  assert.doesNotMatch(mod, /sizes: \{\s*"gap"/, "sizes must not be keyed by size name");
});

test("every tuned density variant is written, not just the selected one", { skip }, () => {
  // Otherwise switching the grid to comfortable finds none of the sizes that
  // were tuned for it.
  const mod = results.__density;
  assert.match(mod, /"comfortable": \{\s*"cellVertical": "sizing\.size_5",/);
  assert.match(mod, /type: "compact"/, "the selected variant is still the type");
});

test("`themeName` never coexists with `theme` — they are aliases", { skip }, () => {
  for (const [name, r] of wiringCases()) {
    assert.ok(!r.clash, `${name}: left a themeName behind, which Handsontable warns about and ignores`);
  }
});

test("wiring never eats the grid it is wiring", { skip }, () => {
  for (const [name, r] of wiringCases()) {
    assert.ok(r.gridIntact, `${name}: the element lost its other props`);
  }
});

test("apply then reset returns the file to exactly how it arrived", { skip }, () => {
  for (const [name, r] of wiringCases()) {
    assert.ok(r.roundTrips, `${name}: reset did not restore the original (a displaced themeName is lost)`);
  }
});
