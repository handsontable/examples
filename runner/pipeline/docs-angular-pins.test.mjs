// DEV-2536 drift guard. Run: pnpm test (the FRAMEWORK_DEV import below needs
// the `--experimental-strip-types` that the `test` script passes).
//
// The docs Angular scaffold hardcodes its Angular/TypeScript pins in
// `wrap-docs-example.mjs`, but the container a docs demo boots in is seeded
// from `containers/live/baked/<bakedKey>/`, which is generated from the
// checked-in `examples/angular` starter. Docs artifacts ship no
// `pnpm-lock.yaml`, so the boot always takes `pnpm install
// --no-frozen-lockfile` against that seeded tree. When the two agree the
// install is a near-no-op; when they drift, pnpm refetches the entire Angular
// tree and the demo takes ~27s to boot.
//
// Nothing else notices the drift: it is not a build error, not a type error,
// and the e2e spec mocks the artifact JSON. So this test pins the two
// implementations together the way `import.test.mjs` does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wrapDocsExample } from "./wrap-docs-example.mjs";
import { FRAMEWORK_DEV } from "../workers/api/src/frameworks.generated.ts";

// Resolve the seed the same way the API worker does: a docs artifact carries no
// fingerprint match, so `workers/api/src/index.ts` falls back to
// `defaultBakedKey`. Deriving it here (rather than hardcoding `angular-18`)
// keeps the guard pointed at the context sessions actually seed when
// `prepare-container.mjs` moves SEED_BUCKET to the next Handsontable major.
const BAKED_KEY = FRAMEWORK_DEV.angular?.defaultBakedKey;

const BAKED_PKG = fileURLToPath(
  new URL(`../containers/live/baked/${BAKED_KEY}/package.json`, import.meta.url),
);

// The two files split dependencies/devDependencies differently — the docs
// scaffold puts the whole toolchain under `dependencies`, the starter splits
// it. That is not drift, so both sides are compared as one merged map.
const merged = (pkg) => Object.assign({}, pkg.dependencies, pkg.devDependencies);

// Handsontable's own packages are pinned per bucket from `hotVersion` and are
// expected to differ; everything else must match.
const isHandsontable = (key) => key === "handsontable" || key.startsWith("@handsontable/");

// No `extraDeps` — per-example extras (papaparse, pikaday, moment, …) are
// covered by `wrap-docs-example.test.mjs` and never appear in the baked
// context, so leaving them out keeps the key-set assertion below exact.
const emitAngularPkg = () =>
  JSON.parse(
    wrapDocsExample({
      framework: "angular",
      hotVersion: "18.0.0",
      exampleId: "example1",
      userFiles: {
        "example1.ts":
          "/* file: app.component.ts */\nimport { Component } from '@angular/core';\n@Component({ selector: 'app-root', template: '' })\nexport class AppComponent {}\n/* end-file */",
        "example1.html": "<app-root></app-root>",
      },
    })["package.json"],
  );

test("docs Angular scaffold pins match the baked container context", () => {
  assert.ok(BAKED_KEY, "FRAMEWORK_DEV.angular declares a defaultBakedKey");

  const emitted = merged(emitAngularPkg());
  const baked = merged(JSON.parse(readFileSync(BAKED_PKG, "utf8")));

  const keys = Object.keys(emitted).filter((key) => !isHandsontable(key));
  assert.ok(keys.length > 0, "the Angular scaffold pins something");

  // Guard the rename/drop case too: a dependency the baked tree no longer
  // carries is drift even though there is no version to compare against.
  const orphaned = keys.filter((key) => !(key in baked));
  assert.deepEqual(
    orphaned,
    [],
    `docs Angular scaffold pins dependencies absent from ${BAKED_PKG}: ${orphaned.join(", ")}`,
  );

  const drifted = keys
    .filter((key) => emitted[key] !== baked[key])
    .map((key) => `${key}: docs ${emitted[key]} != baked ${baked[key]}`);
  assert.deepEqual(
    drifted,
    [],
    `docs Angular pins drifted from the baked container context:\n  ${drifted.join("\n  ")}\n` +
      "Bump the hardcoded block in pipeline/wrap-docs-example.mjs to match, then regenerate the docs buckets.",
  );
});
