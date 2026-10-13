// The status route reports which boot step a session is in. The command
// runs for real against a log file, so a grep that matches nothing fails here.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootStatusCommand, splitBootStatus } from "../workers/api/src/boot-phase.ts";

function statusFor(log) {
  const dir = mkdtempSync(join(tmpdir(), "boot-phase-"));
  const path = join(dir, "boot.log");
  writeFileSync(path, log);
  return splitBootStatus(execSync(bootStatusCommand(path), { encoding: "utf8" }));
}

test("the newest marker names the phase", () => {
  assert.equal(statusFor("::seeding immutable baked dependencies::\n").phase, "seeding");
  assert.equal(statusFor("::seeding immutable baked dependencies::\n::reconciling dependencies with pnpm::\nProgress: 3\n").phase, "installing");
  assert.equal(
    statusFor("::seeding immutable baked dependencies::\n::reconciling dependencies with pnpm::\n::starting dev server::\nready\n").phase,
    "starting",
  );
});

test("the phase survives a log longer than the tail the route returns", () => {
  const noisy = "compiling chunk\n".repeat(400);
  const { phase, log } = statusFor(`::reconciling dependencies with pnpm::\n::starting dev server::\n${noisy}`);
  assert.equal(phase, "starting");
  assert.ok(!log.includes("::starting"), "the marker is outside the 2500-byte tail");
  assert.ok(log.length <= 2500);
});

test("a log with no marker has no phase and keeps its tail", () => {
  const { phase, log } = statusFor("some output\n");
  assert.equal(phase, undefined);
  assert.equal(log, "some output\n");
});

test("a missing log is an empty log", () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-phase-"));
  const out = splitBootStatus(execSync(bootStatusCommand(join(dir, "none.log")), { encoding: "utf8" }));
  assert.deepEqual(out, { phase: undefined, log: "" });
});

test("output without the separator is treated as a bare log", () => {
  assert.deepEqual(splitBootStatus("tail only\n"), { phase: undefined, log: "tail only\n" });
});
