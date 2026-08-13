// The blank starter templates (DEV-2499). Two things are worth guarding:
//
//  1. Minimality — the whole point of the template. A future edit that pulls in
//     a sample-data module or switches a plugin on has to fail here, because
//     nothing else would notice.
//  2. The per-bucket styling idiom (DEV-2200). Below 17 the stylesheets are
//     imported and the theme is named as a string; from 17 up core CSS injects
//     itself and the theme is the JS object. Both mistakes render as a working
//     build with a broken grid, which no smoke test catches.
//
// Run: node --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLANK_FRAMEWORKS, blankStarterFiles } from "./blank-starters.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(dir, "..");
const OUT = path.join(RUNNER_DIR, "apps", "authoring", "public", "starter-examples");
const FRAMEWORKS = JSON.parse(
  fs.readFileSync(path.join(RUNNER_DIR, "config", "frameworks.json"), "utf8"),
).frameworks;

/** Generated file sets, exactly. Anything added shows up here as a diff. */
const EXPECTED_FILES = {
  blank: ["/index.html", "/index.js", "/package.json"],
  "blank-ts": ["/index.html", "/index.ts", "/package.json", "/tsconfig.json"],
  "blank-react": [
    "/index.html",
    "/package.json",
    "/src/index.tsx",
    "/tsconfig.json",
    "/vite.config.ts",
  ],
};

/** The entry file of each template, where the grid is configured. */
const ENTRY = { blank: "/index.js", "blank-ts": "/index.ts", "blank-react": "/src/index.tsx" };

const LEGACY_BUCKETS = ["15", "16"];
const MODERN_BUCKETS = ["17", "18", "next"];

test("the synthetic flags in frameworks.json match this module's templates", () => {
  const flagged = Object.keys(FRAMEWORKS).filter((f) => FRAMEWORKS[f].synthetic);
  assert.deepEqual(flagged.sort(), [...BLANK_FRAMEWORKS].sort());
  for (const framework of BLANK_FRAMEWORKS) {
    // Tier 1 is not incidental: a blank grid must never cost a container boot.
    assert.equal(FRAMEWORKS[framework].tier, 1, `${framework}: tier 1`);
    assert.notEqual(FRAMEWORKS[framework].engine, "container", `${framework}: not container-engine`);
  }
});

test("each template generates exactly its expected file set", () => {
  for (const framework of BLANK_FRAMEWORKS) {
    for (const bucket of [...LEGACY_BUCKETS, ...MODERN_BUCKETS]) {
      const files = blankStarterFiles(framework, { bucket });
      assert.deepEqual(
        Object.keys(files).sort(),
        EXPECTED_FILES[framework],
        `${bucket}/${framework}: file set`,
      );
    }
  }
});

test("the declared entry and htmlEntry exist in the generated files", () => {
  for (const framework of BLANK_FRAMEWORKS) {
    const files = blankStarterFiles(framework, { bucket: "18" });
    const cfg = FRAMEWORKS[framework];
    assert.ok(files[`/${cfg.entry}`], `${framework}: entry /${cfg.entry}`);
    assert.ok(files[`/${cfg.htmlEntry}`], `${framework}: htmlEntry /${cfg.htmlEntry}`);
  }
});

test("templates carry no sample data, helper modules or enabled plugins", () => {
  for (const framework of BLANK_FRAMEWORKS) {
    for (const bucket of [...LEGACY_BUCKETS, ...MODERN_BUCKETS]) {
      const files = blankStarterFiles(framework, { bucket });
      const source = files[ENTRY[framework]];
      const where = `${bucket}/${framework}`;
      for (const banned of [
        "registerPlugin",
        "registerCellType",
        "registerAllModules",
        "registerLanguageDictionary",
        "constants",
        "hooksCallbacks",
        "contextMenu",
        "dropdownMenu",
        "filters",
        "data:",
        "data=",
      ]) {
        assert.equal(source.includes(banned), false, `${where}: entry must not mention ${banned}`);
      }
      // The empty sheet, spelled the way Handsontable spells it.
      assert.match(source, /startRows/, `${where}: startRows`);
      assert.match(source, /startCols/, `${where}: startCols`);
      assert.match(source, /non-commercial-and-evaluation/, `${where}: licenseKey`);
    }
  }
});

test("pre-17 buckets import the stylesheets and name the theme as a string", () => {
  for (const framework of BLANK_FRAMEWORKS) {
    for (const bucket of LEGACY_BUCKETS) {
      const source = blankStarterFiles(framework, { bucket })[ENTRY[framework]];
      const where = `${bucket}/${framework}`;
      assert.match(source, /handsontable\/styles\/handsontable\.min\.css/, `${where}: core CSS`);
      assert.match(source, /handsontable\/styles\/ht-theme-main\.min\.css/, `${where}: theme CSS`);
      assert.match(source, /themeName/, `${where}: string themeName`);
      // `handsontable/themes` does not resolve below 17 — importing it is a
      // bundler error, not a styling nit.
      assert.equal(source.includes("handsontable/themes"), false, `${where}: no themes subpath`);
    }
  }
});

test("17+ buckets use the JS theme object and import no stylesheet", () => {
  for (const framework of BLANK_FRAMEWORKS) {
    for (const bucket of MODERN_BUCKETS) {
      const source = blankStarterFiles(framework, { bucket })[ENTRY[framework]];
      const where = `${bucket}/${framework}`;
      assert.match(source, /import \{ mainTheme \} from 'handsontable\/themes'/, `${where}: mainTheme`);
      // Core CSS auto-injects from 17.0.0; a manual import is what DEV-2200
      // removed everywhere else.
      assert.equal(
        source.includes("handsontable/styles"),
        false,
        `${where}: no manual CSS import`,
      );
      // `themeName` names a stylesheet nothing injects on 17+ — an unstyled grid.
      assert.equal(source.includes("themeName"), false, `${where}: no string themeName`);
    }
  }
});

test("every template pins pnpm so its lockfile matches the container image", () => {
  for (const framework of BLANK_FRAMEWORKS) {
    const pkg = JSON.parse(blankStarterFiles(framework, { bucket: "18" })["/package.json"]);
    assert.equal(pkg.packageManager, "pnpm@10.34.5", `${framework}: packageManager`);
  }
});

test("an unknown synthetic framework fails loudly", () => {
  assert.throws(() => blankStarterFiles("blank-svelte", { bucket: "18" }), /no blank template/);
});

// ---- the committed artifacts, not just the generator ----------------------

test("every bucket on disk carries all three blank artifacts, with a lockfile", () => {
  const buckets = fs
    .readdirSync(OUT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(buckets.length > 0, "has buckets");

  for (const bucket of buckets) {
    const manifest = JSON.parse(fs.readFileSync(path.join(OUT, bucket, "manifest.json"), "utf8"));
    for (const framework of BLANK_FRAMEWORKS) {
      assert.ok(
        manifest.examples.some((row) => row.framework === framework),
        `${bucket}: manifest lists ${framework}`,
      );
      const artifact = JSON.parse(
        fs.readFileSync(path.join(OUT, bucket, `${framework}.json`), "utf8"),
      );
      assert.equal(artifact.htCoreRange, manifest.hotVersion, `${bucket}/${framework}: pinned`);
      // The generator emits no lockfile; the importer resolves one. Without it
      // the snapshot builder's frozen install silently degrades to a fresh
      // resolve, so a demo saved much later builds against different deps.
      assert.ok(artifact.files["/pnpm-lock.yaml"], `${bucket}/${framework}: has a lockfile`);
      assert.deepEqual(
        Object.keys(artifact.files).sort(),
        [...EXPECTED_FILES[framework], "/pnpm-lock.yaml"].sort(),
        `${bucket}/${framework}: artifact file set`,
      );
    }
  }
});

test("the blank templates come first in the catalog index", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "catalog.json"), "utf8"));
  // Index order is picker order (`buildPickerModel` walks it as given), and
  // "start from nothing" belongs at the top of the list.
  assert.deepEqual(
    catalog.examples.slice(0, BLANK_FRAMEWORKS.length).map((e) => e.framework),
    BLANK_FRAMEWORKS,
  );
});
