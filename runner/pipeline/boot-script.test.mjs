// The Tier-2 boot script restores a framework's pre-compiled dev cache between
// the dependency seed and the dev server start, and only for a pristine starter.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootScript, matchesPrimedContext } from "../workers/api/src/boot-script.ts";

const base = {
  root: "/app",
  bakedKey: "next-js-18",
  installLines: ["pnpm install --frozen-lockfile"],
  devCmd: "pnpm exec next dev",
};
const lines = (opts) => bootScript({ ...base, ...opts }).split("\n");

test("a primed starter restores the baked dev cache after the seed and before the dev server", () => {
  const l = lines({ restoreDevCache: true });
  const seed = l.findIndex((x) => x.includes("cp -al /baked/next-js-18/node_modules"));
  const restore = l.findIndex((x) => x.includes("/baked/next-js-18/.next"));
  const start = l.findIndex((x) => x.startsWith("echo '::starting"));
  assert.ok(seed >= 0 && restore > seed && start > restore, JSON.stringify(l));
});

test("an unprimed starter does not restore it", () => {
  assert.ok(!lines({ restoreDevCache: false }).some((x) => x.includes(".next")));
});

test("the restore line is a no-op when the baked context has no cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-script-"));
  const baked = join(dir, "baked", "react-js-18");
  mkdirSync(baked, { recursive: true });
  const restore = lines({ restoreDevCache: true, bakedKey: "react-js-18" }).find((x) => x.includes(".next"));
  const sh = restore.replaceAll("/baked", join(dir, "baked"));
  mkdirSync(join(dir, "app"));
  execFileSync("sh", ["-c", `set -e; cd ${join(dir, "app")}; ${sh}`]);
  assert.equal(existsSync(join(dir, "app", ".next")), false);
  // and copies the cache when it exists
  mkdirSync(join(baked, ".next"));
  writeFileSync(join(baked, ".next", "marker"), "x");
  execFileSync("sh", ["-c", `set -e; cd ${join(dir, "app")}; ${sh}`]);
  assert.equal(existsSync(join(dir, "app", ".next", "marker")), true);
});

test("only the seed bucket's own starter matches the primed context", () => {
  assert.equal(matchesPrimedContext("next-js-18", { bucket: "18" }), true);
  assert.equal(matchesPrimedContext("next-js-18", { bucket: "15" }), false);
  assert.equal(matchesPrimedContext("next-js-18", { bucket: "next" }), false);
  // custom package metadata matches no baked context
  assert.equal(matchesPrimedContext("next-js-18", undefined), false);
});

test("restoring over an existing .next does not nest it", () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-script-"));
  mkdirSync(join(dir, "baked", "k", ".next"), { recursive: true });
  writeFileSync(join(dir, "baked", "k", ".next", "marker"), "x");
  mkdirSync(join(dir, "app", ".next"), { recursive: true });
  const sh = lines({ restoreDevCache: true, bakedKey: "k" }).find((x) => x.includes(".next")).replaceAll("/baked", join(dir, "baked"));
  execFileSync("sh", ["-c", `set -e; cd ${join(dir, "app")}; ${sh}`]);
  assert.equal(existsSync(join(dir, "app", ".next", "marker")), true);
  assert.equal(existsSync(join(dir, "app", ".next", ".next")), false);
});
