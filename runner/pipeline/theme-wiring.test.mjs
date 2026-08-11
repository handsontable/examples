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

// `keep` is the bit of the original that proves wiring edited the file without
// eating what was already in it.
const jsx = (source, keep = "data={data}") => ({ path: "/src/index.tsx", source, keep });

const CASES = {
  jsx: jsx('<HotTable\n  data={data}\n  themeName="ht-theme-main"\n  licenseKey="x"\n/>'),
  jsxOneLine: jsx('<HotTable data={data} themeName="ht-theme-main" licenseKey="x" />'),
  vanilla: jsx("const hot = new Handsontable(el, {\n  data,\n  themeName: 'ht-theme-horizon',\n});", "data,"),
  vanillaOneLine: jsx("const hot = new Handsontable(el, { data, themeName: 'ht-theme-horizon' });", "data,"),
  angular: jsx('gridSettings: GridSettings = {\n  data,\n  themeName: "ht-theme-classic",\n};', "data,"),
  noThemeName: jsx('<HotTable\n  data={data}\n  licenseKey="x"\n/>'),
  ownTheme: jsx("<HotTable data={data} theme={antTheme} />"),
  // A `$` in the displaced value would be read as a replacement pattern if the
  // restore used `$1...` string substitution instead of a function.
  dollar: jsx('<HotTable data={data} themeName="ht-$pecial" />'),

  // The two vanilla shapes the census found the old regex walking past
  // (DEV-2197) — between them, 16 of the 17 docs examples it was missing.
  vanillaExpressionElement: jsx(
    "const hot = new Handsontable(document.getElementById('dts-hot'), {\n  data,\n  rowHeaders: true,\n});",
    "data,",
  ),
  vanillaNamedSettings: jsx(
    "const hotOptions = {\n  data,\n  rowHeaders: true,\n};\n\nconst hot = new Handsontable(container, hotOptions);",
    "data,",
  ),
  // …and the shape that must still be left alone: no object literal to attach
  // to means no safe edit.
  vanillaComputedSettings: {
    path: "/src/index.tsx",
    keep: "buildSettings()",
    source: "const hot = new Handsontable(container, buildSettings());",
    unwired: true,
  },

  // A CSS theme on the container silently out-ranks the theme object, so it has
  // to come off — and go back on at Reset (DEV-2197).
  containerClass: jsx(
    '<div className="wrap ht-theme-main">\n  <HotTable data={data} />\n</div>',
    "data={data}",
  ),
  containerClassOnly: jsx(
    '<div className="ht-theme-main">\n  <HotTable data={data} />\n</div>',
    "data={data}",
  ),

  // A Vue SFC is not JSX in a different file extension (DEV-2197): the binding
  // is `:theme="..."` and an import above the blocks is not a valid SFC at all.
  // Every docs example is `<script setup>`; the catalog's Vue starter is not,
  // and under the Options API an import is invisible to the template.
  vueSetup: {
    path: "/src/App.vue",
    keep: ':data="data"',
    source: '<script setup lang="ts">\nimport { HotTable } from \'@handsontable/vue3\';\n'
      + "import { data } from './data';\n</script>\n\n<template>\n  <HotTable :data=\"data\" :rowHeaders=\"true\" />\n</template>\n",
  },
  vueOptions: {
    path: "/src/components/DataGrid.vue",
    keep: ':data="dataProp"',
    source: '<script lang="ts">\nimport { defineComponent } from \'vue\';\n'
      + "import { HotTable } from '@handsontable/vue3';\n\nexport default defineComponent({\n"
      + "  name: 'DataGrid',\n  components: { HotTable },\n});\n</script>\n\n"
      + '<template>\n  <div id="example">\n    <HotTable :data="dataProp" :rowHeaders="true" />\n  </div>\n</template>\n',
  },
  vueThemeNameBind: {
    path: "/src/App.vue",
    keep: ':data="data"',
    source: '<script setup lang="ts">\nimport { HotTable } from \'@handsontable/vue3\';\n</script>\n\n'
      + '<template>\n  <HotTable :data="data" :themeName="themeName" />\n</template>\n',
  },
  // Astro builds the grid in a client <script>. Frontmatter runs on the server,
  // so an import written there — or above the markup — never reaches the call.
  astro: {
    path: "/src/components/Grid.astro",
    keep: "rowHeaders: true,",
    source: '<div id="example"></div>\n\n<script>\n  import Handsontable from "handsontable/base";\n'
      + "  import { data } from '../data';\n\n  const example = document.getElementById(\"example\");\n\n"
      + "  new Handsontable(example, {\n    data: data,\n    rowHeaders: true,\n  });\n</script>\n",
  },
};

const SCRIPT = `
const { buildThemeChanges, buildResetChanges, buildThemeModule } = await import("./theme/codegen.ts");
const { DEFAULT_THEME } = await import("./theme/vocabulary.ts");
const cases = ${JSON.stringify(CASES)};
const out = {};
for (const [name, { path, source: original, keep, unwired }] of Object.entries(cases)) {
  const files = { [path]: original };
  const { changes, linked } = buildThemeChanges(files, { ...DEFAULT_THEME, params: { accentColor: "#f00" } });
  for (const c of changes) files[c.path] = c.contents;
  const applied = files[path];
  const code = applied.split("\\n").filter((l) => !l.includes("handsontable-theme")).join("\\n");
  for (const c of buildResetChanges(files)) files[c.path] = c.contents;
  out[name] = {
    linked,
    applied,
    unwired: Boolean(unwired),
    wired: code.includes("theme={customTheme}")
      || code.includes("theme: customTheme")
      || code.includes(':theme="customTheme"'),
    clash: /\\bthemeName\\s*[=:]/.test(code),
    gridIntact: code.includes(keep),
    roundTrips: files[path].trim() === original.trim(),
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
    if (r.unwired) continue;
    assert.ok(r.wired, `${name}: theme was not handed to the grid`);
  }
});

test("a construction with no settings literal is left alone", { skip }, () => {
  // The whole posture: the panel writes the module and shows the line to add.
  // A settings object returned by a function has nowhere safe to take an edit,
  // and a mangled component file is worse than an unstyled demo.
  const r = results.vanillaComputedSettings;
  assert.equal(r.linked, false, "it must report itself unwired, so the panel shows the hint");
  assert.ok(!r.wired, "and must not have been edited anyway");
  assert.ok(r.roundTrips, "the source must come back untouched");
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

test("a CSS theme on the container is taken off, and only that", { skip }, () => {
  // Handsontable honours a theme *object* only when the container carries no
  // `ht-theme-*` class — and says nothing when it does, unlike the
  // theme/themeName pair, which at least warns. Five starters wrap their grid
  // in `<div class="ht-theme-main">` and ignored the panel outright.
  // The marker line legitimately still holds the class it displaced — that is
  // how Reset puts it back — so read the code, not the comment.
  const code = (name) => results[name].applied
    .split("\n").filter((l) => !l.includes("handsontable-theme")).join("\n");

  assert.doesNotMatch(code("containerClass"), /ht-theme-main/, "the CSS theme must be gone while a theme is applied");
  assert.match(code("containerClass"), /className="wrap"/, "the container's other classes must survive");
  assert.match(code("containerClassOnly"), /className=""/, "an emptied class attribute stays put");
});

test("a Vue SFC gets a binding, not a JSX attribute", { skip }, () => {
  // `theme={customTheme}` in a Vue template is the literal string
  // "{customTheme}" — the grid takes it, finds no such theme, and renders
  // unstyled. Nothing in the generated source looks wrong, which is why this
  // survived until a browser ran it (DEV-2197).
  for (const name of ["vueSetup", "vueOptions", "vueThemeNameBind"]) {
    const applied = results[name].applied;
    assert.match(applied, /:theme="customTheme"/, `${name}: expected a Vue binding`);
    assert.doesNotMatch(applied, /theme=\{customTheme\}/, `${name}: JSX syntax in a Vue template`);
  }
});

test("a Vue import lands inside the script block, not above the SFC", { skip }, () => {
  // An import above `<template>`/`<script>` is not a valid SFC at all: the demo
  // stops compiling, so the file is worse off than if we had left it alone.
  for (const name of ["vueSetup", "vueOptions", "vueThemeNameBind"]) {
    const applied = results[name].applied;
    const importAt = applied.indexOf("import { customTheme }");
    const scriptAt = applied.search(/<script\b/);
    assert.ok(importAt > scriptAt, `${name}: the import is outside the script block`);
    assert.ok(applied.startsWith("<script"), `${name}: the SFC no longer opens with its first block`);
  }
});

test("an Options-API SFC exposes the theme to its template", { skip }, () => {
  // `<script setup>` exposes its imports to the template; the Options API does
  // not, so `:theme="customTheme"` there resolves to undefined without a
  // `setup()` returning it. Every docs example is script-setup — the catalog's
  // own Vue starter is the one that is not.
  assert.match(results.vueOptions.applied, /setup\(\) \{ return \{ customTheme \}; \}/);
  assert.doesNotMatch(
    results.vueSetup.applied,
    /setup\(\) \{ return/,
    "script-setup needs no shim, and adding one would redeclare the block",
  );
});

test("an Astro import lands in the client script that builds the grid", { skip }, () => {
  // `.astro` frontmatter runs on the server: a binding declared between the
  // `---` fences never reaches the browser, and above the markup the import is
  // not code at all, just text in the template.
  const applied = results.astro.applied;
  const scriptAt = applied.indexOf("<script>");
  const importAt = applied.indexOf("import { customTheme }");
  const callAt = applied.indexOf("new Handsontable(");
  assert.ok(importAt > scriptAt, "the import must be inside the <script> block");
  assert.ok(importAt < callAt, "and above the call that uses it");
  assert.ok(applied.startsWith('<div id="example">'), "the markup must still come first");
});

test("apply then reset returns the file to exactly how it arrived", { skip }, () => {
  for (const [name, r] of wiringCases()) {
    assert.ok(r.roundTrips, `${name}: reset did not restore the original (a displaced themeName is lost)`);
  }
});
