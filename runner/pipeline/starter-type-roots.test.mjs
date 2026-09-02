import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

// DEV-2730: every `compilerOptions.types` entry a starter names must be a package
// that starter itself declares.
//
// A `types` entry is resolved by walking parent directories, so a starter can name
// a type package it never depends on and still build here — this repo has an
// untracked `node_modules/@types/node` at its root, and `tsc` finds it from
// `examples/<starter>/`. Nowhere the starter actually runs has that ancestor: not
// the ZIP a user downloads (`downloadWorkspaceZip` ships `/package.json`,
// `/tsconfig*.json` and `/pnpm-lock.yaml` verbatim), not a bare clone of one
// starter directory, not `/app` in the live container. There `tsc -b && vite build`
// — the starter's own documented build script — dies with
// `TS2688: Cannot find type definition file for 'node'`.
//
// Reads `examples/` rather than the generated buckets under
// `apps/authoring/public/starter-examples/`, unlike `starter-scheme.test.mjs`. The
// buckets are derived: a source fix does not reach them until the "Import versioned
// starter examples" workflow regenerates them, so a bucket-based gate would need a
// `todo` on `next`, `17` and `18` on the day it lands — green by exemption
// everywhere, which is not a gate. Source-level is green the moment the fix lands
// and rides the cherry-pick onto `prod-examples/*`, where ci.yml's `pull_request: {}`
// runs it too.
//
// Known limit: `extends` chains are not followed. A starter that inherits `types`
// from `@vue/tsconfig` or `@tsconfig/node20` is not inspected here, because the
// inherited entry is that package's problem and its package is declared by
// definition. Only what a starter writes in its own file is its own to get right.

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..", "..", "examples");

/** Every `examples/<dir>` that carries a package.json. */
function starterDirs() {
  return readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(EXAMPLES, e.name, "package.json")))
    .map((e) => e.name)
    .sort();
}

/** Parse a tsconfig the way TypeScript does — the starters' configs carry comments
 *  and trailing commas, and a hand-rolled comment strip mangles `next.js` and
 *  `next-shadcn.js`. A parse failure is a test failure, never a silent skip: the
 *  configs most likely to grow a `types` array must not be able to exempt
 *  themselves by being unparseable. */
function readTsconfig(file) {
  const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  assert.equal(error, undefined, `${file}: ${error && ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  return config ?? {};
}

/** The package a type-reference entry resolves to, and the names that satisfy it.
 *  A bare `node` is served by `@types/node` or by a self-typed `node` package; a
 *  scoped or sub-path entry (`@remix-run/node`, `vite/client`) names its package
 *  directly, with the DefinitelyTyped mangling as the scoped alternative. */
function candidatePackages(entry) {
  const seg = entry.split("/");
  if (entry.startsWith("@")) {
    const pkg = seg.slice(0, 2).join("/");
    return seg.length === 2 ? [pkg, `@types/${seg[0].slice(1)}__${seg[1]}`] : [pkg];
  }
  return seg.length > 1 ? [seg[0]] : [`@types/${entry}`, entry];
}

test("every starter declares the type packages its tsconfigs name", () => {
  const starters = starterDirs();
  // A renamed path or a filter that matches nothing must fail here rather than
  // pass with zero assertions.
  assert.ok(starters.length >= 15, `found ${starters.length} starters under ${EXAMPLES}`);

  const undeclared = [];
  let inspected = 0;

  for (const starter of starters) {
    const dir = join(EXAMPLES, starter);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));

    for (const name of readdirSync(dir).filter((n) => /^tsconfig.*\.json$/.test(n))) {
      const types = readTsconfig(join(dir, name)).compilerOptions?.types;
      if (!Array.isArray(types)) continue;
      for (const entry of types) {
        inspected += 1;
        const candidates = candidatePackages(entry);
        if (candidates.some((c) => declared.has(c))) continue;
        undeclared.push(`${starter}/${name}: types["${entry}"] — declares none of ${candidates.join(", ")}`);
      }
    }
  }

  assert.ok(inspected > 0, "no `types` entry was inspected — the check read nothing");
  assert.deepEqual(
    undeclared,
    [],
    "a `types` entry resolves only through an ancestor node_modules; outside this repo it is TS2688",
  );
});
