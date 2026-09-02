import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BUILD_CONFIG } from "../workers/api/src/frameworks.generated.ts";

// DEV-2737: `BUILD_CONFIG` must not drop a type-check that the starter's own
// build script performs.
//
// `BUILD_CONFIG.buildCommand` is a hand-written field in `config/frameworks.json`
// that travels to the worker via `catalog.json` — the starter's own
// `package.json` `scripts.build` is never read. So the two can drift silently,
// and drift in this direction is invisible twice over: the share path is the only
// product code that runs a build, and it never type-checks anyway because
// `snapshotBuildCommand` strips a leading `tsc` / `tsc -b` / `vue-tsc`
// (`workers/api/src/build-command.ts`). A dropped type-check therefore changes
// nothing observable until someone runs the declared command un-stripped — a
// downloaded ZIP, a bare clone, `examples-build.yml`.
//
// This is what the test caught when it was written: `vue`'s entry said
// `vite build` while `examples/vue` builds with
// `run-p type-check "build-only {@}" --`, so the `vue-tsc` pass existed in the
// starter and nowhere in our config.
//
// A property, not string equality. Equality would need an allowlist, and the one
// framework that would have to go in it is `vue` — allowlisting the defect is the
// silence this test exists to break. The property also lets the intentional
// divergences through on their own merit: `nuxt` is `nuxt generate` here against
// `nuxt build` in the starter (static export, `outputDir: .output/public`) and
// neither side type-checks, so there is nothing to preserve.

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, "..", "..", "examples");

/** Does this command run a type-checker?
 *
 *  `tsc`/`vue-tsc` are explicit. `ng build` and `next build` type-check as part of
 *  the build itself (Angular's AOT pass; Next unless `typescript.ignoreBuildErrors`
 *  is set, which no starter sets). `run-p ... type-check` is how `examples/vue`
 *  reaches `vue-tsc` through `npm-run-all2`. */
function typeChecks(command) {
  return /\btsc\b|\bvue-tsc\b|\bng build\b|\bnext build\b|type-check|\btypecheck\b/.test(command);
}

/** `scripts.build` of every `examples/<dir>` that declares one, keyed by dir name —
 *  the same key space as `BUILD_CONFIG` (the synthetic `blank*` templates have no
 *  directory and so no counterpart here). */
function starterBuildScripts() {
  const entries = readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(EXAMPLES, e.name, "package.json"))
    .filter((file) => existsSync(file));

  return new Map(
    entries.flatMap((file) => {
      const build = JSON.parse(readFileSync(file, "utf8")).scripts?.build;
      return build ? [[dirname(file).split("/").pop(), build]] : [];
    }),
  );
}

test("BUILD_CONFIG keeps every type-check the starter's own build performs", () => {
  const starters = starterBuildScripts();
  // A renamed directory or a filter that matches nothing must fail here rather
  // than pass with zero assertions.
  assert.ok(starters.size >= 15, `found ${starters.size} starter build scripts under ${EXAMPLES}`);

  const paired = [...starters].filter(([framework]) => BUILD_CONFIG[framework]);
  assert.ok(
    paired.length >= 15,
    `only ${paired.length} of ${starters.size} starters have a BUILD_CONFIG entry`,
  );

  for (const [framework, starterBuild] of paired) {
    if (!typeChecks(starterBuild)) continue;
    const { buildCommand } = BUILD_CONFIG[framework];
    assert.ok(
      typeChecks(buildCommand),
      `${framework}: examples/${framework} builds with \`${starterBuild}\`, which type-checks, ` +
        `but BUILD_CONFIG.buildCommand is \`${buildCommand}\`, which does not. Add the check to ` +
        `config/frameworks.json and regenerate, or the starter's type surface is declared nowhere.`,
    );
  }

  // The predicate has to be able to say no, or the loop above is decorative.
  assert.equal(typeChecks("vite build"), false);
  assert.equal(typeChecks("tsc -b && vite build"), true);
});
