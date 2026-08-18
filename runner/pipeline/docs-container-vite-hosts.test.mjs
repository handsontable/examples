// DEV-2564 class guard. Run: pnpm test (the FRAMEWORK_DEV import below needs the
// `--experimental-strip-types` that the `test` script passes).
//
// A Tier-2 (`engine: "container"`) docs example runs a real dev server, reached only
// through the Sandbox SDK preview proxy. The proxy forwards a WebSocket upgrade
// bearing the ORIGINAL preview `Host`, and vite gates the HMR upgrade on
// `server.allowedHosts` (default `[]`), so an un-opted-in container renders fine and
// silently never hot-reloads. There are two ways to opt in and they do NOT cover the
// same ground:
//
//   - `server: { allowedHosts: true }` in the project's own vite config — works on
//     every vite major;
//   - the `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` variable the API worker injects
//     (DEV-2541, workers/api/src/preview-allowed-hosts.ts) — only exists from vite 6.
//
// DEV-2541 shipped believing the variable covered everything. It did not: the docs Vue
// container is pinned to vite 5, where the name does not appear anywhere in `dist`, so
// ~500 Vue docs examples kept refusing the upgrade with no boot failure and no error.
// Both directions of that mistake are silent — a config that loses its `server` block,
// and a vite pin that drops below 6 — which is why the pairing is asserted here rather
// than left to be noticed in a browser console.
//
// The vite version each container will actually run is read from its baked lockfile,
// not guessed: Angular declares no vite at all and still runs 7.3.5 via
// `@angular/build`, so a check that only looked at declared dependencies would call it
// vite-less and wave it through.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as acorn from "acorn";
import { fileURLToPath } from "node:url";
import { RUNNER } from "./import-docs.mjs";
import { wrapDocsExample } from "./wrap-docs-example.mjs";
import { FRAMEWORK_DEV } from "../workers/api/src/frameworks.generated.ts";

const HOT_VERSION = "18.0.0";

// One minimal example per framework, in the file shape the importer hands over.
// Keyed by RUNNER key so a new container framework fails the coverage assertion
// below with a clear message instead of being skipped.
const SAMPLES = {
  vue: {
    "example1.vue": "<template><div /></template>\n",
  },
  angular: {
    "example1.ts":
      "/* file: app.component.ts */\nimport { Component } from '@angular/core';\n" +
      "@Component({ selector: 'app-root', template: '' })\nexport class AppComponent {}\n/* end-file */",
    "example1.html": "<app-root></app-root>",
  },
};

const containerFrameworks = Object.entries(RUNNER)
  .filter(([, config]) => config.engine === "container")
  .map(([key]) => key);

const emit = (framework) =>
  wrapDocsExample({
    framework,
    hotVersion: HOT_VERSION,
    exampleId: "example1",
    userFiles: SAMPLES[framework],
  });

/** The vite config a project ships, whatever extension it uses (or null). */
const viteConfigOf = (files) => {
  const key = Object.keys(files).find((name) => /^vite\.config\.[cm]?[jt]s$/.test(name));
  return key === undefined ? null : files[key];
};

/** Lowest major a semver range can resolve to — enough to answer "could this be < 6?". */
const rangeMinMajor = (range) => {
  const major = /(\d+)\./.exec(String(range ?? ""))?.[1];
  return major === undefined ? null : Number(major);
};

const bakedDir = (framework) => {
  const key = FRAMEWORK_DEV[framework]?.defaultBakedKey;
  assert.ok(key, `FRAMEWORK_DEV.${framework} declares a defaultBakedKey`);
  return fileURLToPath(new URL(`../containers/live/baked/${key}/`, import.meta.url));
};

/**
 * The vite major the container will really run, read out of its baked lockfile.
 *
 * pnpm writes one `  vite@<version>:` entry per resolved version in the `snapshots`/
 * `packages` sections. Transitive is what matters here — Angular gets its vite from
 * `@angular/build`, never from a declared dependency.
 */
const bakedViteMajors = (framework) => {
  const lock = readFileSync(`${bakedDir(framework)}pnpm-lock.yaml`, "utf8");
  return [...new Set([...lock.matchAll(/^ {2}'?vite@(\d+)\./gm)].map((m) => Number(m[1])))];
};

test("every container docs framework is covered by a sample here", () => {
  const missing = containerFrameworks.filter((framework) => !SAMPLES[framework]);
  assert.deepEqual(
    missing,
    [],
    `RUNNER declares container frameworks with no sample in this test: ${missing.join(", ")}. ` +
      "Add one — otherwise this guard silently stops covering them.",
  );
  assert.ok(containerFrameworks.length > 0, "RUNNER declares at least one container framework");
});

test("every container docs framework opts in to the preview host, one way or the other", () => {
  const failures = [];

  for (const framework of containerFrameworks) {
    const files = emit(framework);
    const config = viteConfigOf(files);
    const declared = rangeMinMajor(JSON.parse(files["package.json"]).dependencies?.vite);
    const resolved = bakedViteMajors(framework);
    // Nothing on vite at all: no host gate to open.
    if (declared === null && resolved.length === 0) continue;

    const byConfig = config !== null && /allowedHosts/.test(config);
    // The env var only exists from vite 6, so EVERY vite the container could run has
    // to be >= 6 for that branch to hold — a declared range that can float down to 5
    // counts against it.
    const lowest = Math.min(...[declared, ...resolved].filter((major) => major !== null));
    if (byConfig || lowest >= 6) continue;

    failures.push(
      `${framework}: runs vite ${lowest} (declared ${declared ?? "-"}, baked ${resolved.join("/") || "-"}) ` +
        `and its vite config ${config === null ? "does not exist" : "has no allowedHosts"}`,
    );
  }

  assert.deepEqual(
    failures,
    [],
    "container docs projects whose HMR upgrade the preview proxy will get refused:\n  " +
      `${failures.join("\n  ")}\n` +
      "Add DOCS_VITE_SERVER_BLOCK to the framework's generated vite config in " +
      "pipeline/wrap-docs-example.mjs (below vite 6 that is the only option — " +
      "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS does not exist there).",
  );
});

test("the Vue docs config carries the opt-in itself, not just a high enough vite", () => {
  // Vue is the framework DEV-2564 is about, and the one where the environment variable
  // cannot help. Asserted directly rather than only through the rule above so that a
  // future bump of the vue pin to >= 6 cannot make the block look optional and get
  // dropped — the config route is what keeps this version-proof.
  const config = viteConfigOf(emit("vue"));
  assert.ok(config, "the vue docs project ships a vite config");
  assert.match(
    config,
    /server:\s*\{\s*allowedHosts:\s*true\s*\}/,
    "the generated vue vite config must set server.allowedHosts",
  );
});

test("the config that actually ships parses", () => {
  // The boot test in vite-allowed-hosts.test.mjs runs a stripped, plugin-less config
  // (`@vitejs/plugin-vue` is not resolvable from a temp dir), so nothing there parses
  // the text that reaches the artifacts — where the block is interpolated AFTER
  // `plugins: [vue()], `. An edit that is valid standalone and broken in that position
  // would pass every other assertion here and take the container's boot down with a
  // syntax error. This repo has been caught by exactly that gap before: a hand-written
  // ES5 file with an ES2017 trailing comma that `new Function` accepted and the
  // shipping parser did not.
  const config = viteConfigOf(emit("vue"));
  acorn.parse(config, { ecmaVersion: 2020, sourceType: "module" });
});

test("the Vue docs vite pin matches the baked container it installs against", () => {
  // Same drift guard docs-angular-pins.test.mjs applies to Angular: docs artifacts ship
  // no lockfile, so a session installs the emitted package.json against the seeded
  // node_modules. When the two pins disagree pnpm refetches the whole tree — and, worse
  // here, the vite the container runs stops being the one this test reasoned about.
  const emitted = JSON.parse(emit("vue")["package.json"]).dependencies;
  const baked = JSON.parse(readFileSync(`${bakedDir("vue")}package.json`, "utf8")).dependencies;

  for (const name of ["vite", "@vitejs/plugin-vue"]) {
    assert.equal(
      emitted[name],
      baked[name],
      `${name}: docs pin ${emitted[name]} != baked ${baked[name]}. ` +
        "Update extraContainer() in scripts/prepare-container.mjs and buildVueProject() together.",
    );
  }
});
