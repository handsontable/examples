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
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { setSandboxFactory } from "./fixtures/cloudflare-sandbox-stub.mjs";

// register() is synchronous by contract (node:module docs) — nothing to
// await. The worker imports below are dynamic, so they evaluate strictly
// after the .js->.ts remap and the sandbox stub are live.
register("./fixtures/worker-hooks.mjs", import.meta.url);

const { runBuild, BuildFailure } = await import("../workers/api/src/share.ts");

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
