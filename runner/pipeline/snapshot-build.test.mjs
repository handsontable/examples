// The snapshot builder's install gate (Sentry DEMOS-31).
//
// `share.ts` declares its own structural `SandboxLike` for `exec()`, in which
// `success` is OPTIONAL (`{ success?: boolean; ...; exitCode?: number }`) —
// looser than the real SDK's `ExecResult`, which requires both `success` and
// `exitCode`. `runBuild`'s install gate only ever tested `install.success ===
// false`, so a result carrying just a nonzero `exitCode` and no `success`
// field sailed past the check twice and let the build run against an empty
// `node_modules`. This drives `runBuild` directly — no route test ever
// reaches it, because the harness's `build_cache` always hits — with a
// scripted sandbox that answers exactly that shape.
//
// Also covers the *other* DEMOS-31 event (the theme-CSS exports-map one, see
// the investigation note on that issue): that event was undiagnosable because
// the report carried no `ht_version` — nothing said which Handsontable build
// the container had installed. This is not a fix (the cause was an upstream
// pkg.pr.new packaging gap that has since closed); it only attaches the
// pinned build ref and framework to `BuildFailure` and to the Sentry tags, so
// a recurrence is one `search_events` facet instead of tarball archaeology.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

// register() is synchronous by contract (node:module docs) — nothing to
// await. The worker imports below are dynamic, so they evaluate strictly
// after the .js->.ts remap and the sandbox stub are live.
register("./fixtures/worker-hooks.mjs", import.meta.url);

const { runBuild, BuildFailure, buildFailureTags } = await import("../workers/api/src/share.ts");

// Mirrors ht-version-resolve.test.mjs's own `filesWith` — a minimal
// package.json declaring `handsontable` at `dep`.
const filesWith = (dep) => ({ "/package.json": JSON.stringify({ dependencies: { handsontable: dep } }) });

/** A sandbox whose install succeeds and whose build fails with the exact
 *  `buildLog` the theme-CSS event carried (Sentry DEMOS-31, event
 *  724df785…). Tied to the report it came from, not a paraphrase of it. */
function failingBuildSandbox() {
  return {
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async () => "",
    destroy: async () => {},
    async exec(cmd) {
      if (cmd.includes("pnpm install")) return { success: true, exitCode: 0, stdout: "", stderr: "" };
      return {
        success: false,
        exitCode: 1,
        stdout: "",
        stderr:
          'error during build:\n[commonjs--resolver] Missing "./styles/ht-theme-main.min.css" specifier in "handsontable" package',
      };
    },
  };
}

const ENV = { SANDBOX_BUILDER: {} };

const ENTRY = {
  framework: "react",
  tier: 1,
  installCommand: "pnpm install --frozen-lockfile",
  buildCommand: "tsc -b && vite build",
  outputDir: "dist",
  outputGlob: null,
};

test("an install that reports only a nonzero exit code still fails the build", async () => {
  const execs = [];
  setSandboxFactory(() => ({
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async () => "",
    destroy: async () => {},
    async exec(cmd) {
      execs.push(cmd);
      // Both installs answer the way the structural SandboxLike permits and
      // the old `=== false` check could not see: an exit code, and no
      // `success` field.
      if (cmd.includes("pnpm install")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            " ERR_PNPM_NO_MATCHING_VERSION  No matching version found for handsontable@13106",
        };
      }
      return { success: true, exitCode: 0, stdout: "", stderr: "" };
    },
  }));
  try {
    const err = await runBuild(ENV, ENTRY, { "/package.json": "{}" }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof BuildFailure, `expected a BuildFailure, got ${err}`);
    // THE discriminating assertion: it failed at the install, not later.
    assert.equal(err.phase, "install");
    assert.equal(err.code, "ERR_PNPM_NO_MATCHING_VERSION");
    assert.ok(
      !execs.some((c) => c.includes("node_modules/.bin")),
      "no build may be attempted after a failed install",
    );
  } finally {
    setSandboxFactory(null);
  }
});

test("the frozen-install retry still happens on a plain success: false, so the new check cannot be narrowed back", async () => {
  const execs = [];
  setSandboxFactory(() => ({
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async () => "",
    destroy: async () => {},
    async exec(cmd) {
      execs.push(cmd);
      if (cmd.includes("pnpm install") && !cmd.includes("--no-frozen-lockfile")) {
        return { success: false, exitCode: 1, stdout: "", stderr: "ERR_PNPM_OUTDATED_LOCKFILE" };
      }
      if (cmd.includes("pnpm install")) {
        return { success: true, exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("node_modules/.bin")) {
        return { success: true, exitCode: 0, stdout: "", stderr: "" };
      }
      return { success: true, exitCode: 0, stdout: "" };
    },
  }));
  try {
    // No files listed for the build's "find" step, so this throws a plain
    // Error("build produced no files ...") after the retry succeeds — proof
    // that the retry ran and the build was attempted, not that runBuild
    // fully succeeds end to end.
    const err = await runBuild(ENV, ENTRY, { "/package.json": "{}" }).then(
      () => null,
      (e) => e,
    );
    assert.ok(
      execs.some((c) => c.includes("--no-frozen-lockfile")),
      "the non-frozen retry must still run on a plain success: false",
    );
    assert.ok(!(err instanceof BuildFailure), "the retry succeeded, so this must not be an install BuildFailure");
  } finally {
    setSandboxFactory(null);
  }
});

test("a build failure names the Handsontable build the container installed", async () => {
  setSandboxFactory(failingBuildSandbox);
  try {
    const err = await runBuild(ENV, ENTRY, filesWith("https://pkg.pr.new/handsontable@13106")).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof BuildFailure, `expected a BuildFailure, got ${err}`);
    // Discriminating: today undefined !== "13106" and undefined !== "react",
    // because BuildFailure carries neither field yet.
    assert.equal(err.htRef, "13106");
    assert.equal(err.framework, "react");
    // Pins the exact object that reaches Sentry — the two field assertions
    // above do not. Today this line cannot even run: buildFailureTags does
    // not exist, so the destructure above yields undefined and this throws
    // TypeError before the assertion is reached.
    assert.deepEqual(buildFailureTags(err), {
      context: "snapshot-build",
      build_phase: "build",
      ht_version: "13106",
      framework: "react",
    });
    // The existing contract (DEV-2570) is unharmed by the new fields.
    assert.equal(err.phase, "build");
    assert.ok(!err.message.includes("\n"));
  } finally {
    setSandboxFactory(null);
  }
});

test("a range-pinned manifest omits the version tag rather than inventing one", async () => {
  setSandboxFactory(failingBuildSandbox);
  try {
    const err = await runBuild(ENV, ENTRY, filesWith("^18.0.0")).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof BuildFailure, `expected a BuildFailure, got ${err}`);
    assert.equal(err.htRef, null);
    // The discriminating part: no `ht_version` key at all — not a stringified
    // "null" (a naive `String(err.htRef)`) and not an `undefined` value (a
    // naive `err.htRef ?? undefined`). deepEqual distinguishes an absent key
    // from a present-but-undefined one, which is exactly the trap this test
    // exists to catch.
    assert.deepEqual(buildFailureTags(err), {
      context: "snapshot-build",
      build_phase: "build",
      framework: "react",
    });
  } finally {
    setSandboxFactory(null);
  }
});

test("an install failure carries the same build context", async () => {
  setSandboxFactory(() => ({
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async () => "",
    destroy: async () => {},
    async exec(cmd) {
      if (cmd.includes("pnpm install")) {
        return {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr:
            " ERR_PNPM_NO_MATCHING_VERSION  No matching version found for handsontable@13106",
        };
      }
      return { success: true, exitCode: 0, stdout: "", stderr: "" };
    },
  }));
  try {
    const err = await runBuild(ENV, ENTRY, filesWith("https://pkg.pr.new/handsontable@13106")).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof BuildFailure, `expected a BuildFailure, got ${err}`);
    // Proves the context is attached at both throw sites, not only the build
    // one the theme-CSS event happened to hit.
    assert.equal(err.phase, "install");
    assert.equal(err.htRef, "13106");
  } finally {
    setSandboxFactory(null);
  }
});
