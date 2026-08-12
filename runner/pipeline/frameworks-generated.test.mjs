// Shape guard for the generated FRAMEWORK_DEV contexts (DEV-2213): the API
// worker selects a baked context by dependency fingerprint and falls back to
// defaultBakedKey, so a malformed regeneration must fail here, not at session
// boot. Run: node --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { FRAMEWORK_DEV, BUILD_CONFIG } from "../workers/api/src/frameworks.generated.ts";

const HEX_64 = /^[0-9a-f]{64}$/;

test("every FRAMEWORK_DEV row has resolvable baked contexts", () => {
  const frameworks = Object.keys(FRAMEWORK_DEV);
  assert.ok(frameworks.length > 0, "has container frameworks");
  for (const [framework, dev] of Object.entries(FRAMEWORK_DEV)) {
    assert.ok(dev.contexts.length > 0, `${framework}: has contexts`);
    assert.ok(
      dev.contexts.some((c) => c.bakedKey === dev.defaultBakedKey),
      `${framework}: defaultBakedKey is one of its contexts`,
    );
    const fingerprints = dev.contexts.map((c) => c.sourceDependencyFingerprint);
    for (const fp of fingerprints) assert.match(fp, HEX_64, `${framework}: sha256 fingerprint`);
    assert.equal(
      new Set(fingerprints).size,
      fingerprints.length,
      `${framework}: fingerprints are distinct (a collision would make bucket selection ambiguous)`,
    );
    assert.equal(typeof dev.cmd, "string");
    assert.equal(typeof dev.port, "number");
  }
});

test("BUILD_CONFIG covers every catalog framework", async () => {
  const fs = await import("node:fs");
  const catalog = JSON.parse(fs.readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
  for (const e of catalog.examples) {
    assert.ok(BUILD_CONFIG[e.framework], `${e.framework} in BUILD_CONFIG`);
  }
});

test("baked fingerprints match the bucket artifacts they were derived from", async () => {
  // The frozen fast path only opens when the client's mounted files hash to a
  // baked fingerprint — and on a match the boot script hard-fails instead of
  // retrying non-frozen. Regenerating buckets without prepare-container (or
  // vice versa) would silently break that invariant; catch the drift here.
  const fs = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const part = (name, value) =>
    value === undefined ? `${name}:missing\n` : `${name}:${value.length}:${value}\n`;
  const fingerprint = ({ packageJson, pnpmLock }) =>
    createHash("sha256")
      .update(`${part("package.json", packageJson)}${part("pnpm-lock.yaml", pnpmLock)}`)
      .digest("hex");

  const bucketsDir = new URL("../apps/authoring/public/starter-examples/", import.meta.url);
  const catalog = JSON.parse(fs.readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
  const containerStarters = new Set(
    catalog.examples.filter((e) => e.engine === "container").map((e) => e.framework),
  );
  let checked = 0;
  for (const [framework, dev] of Object.entries(FRAMEWORK_DEV)) {
    // Docs-only extras (vue) are baked from a synthetic package.json in
    // prepare-container.mjs, not from a starter artifact — nothing to compare.
    if (!containerStarters.has(framework)) continue;
    for (const context of dev.contexts) {
      const bucket = context.bakedKey.split("-").at(-1);
      const artifactUrl = new URL(`${bucket}/${framework}.json`, bucketsDir);
      if (!fs.existsSync(artifactUrl)) continue; // bucket without this framework (minCoreMajor floor)
      const artifact = JSON.parse(fs.readFileSync(artifactUrl, "utf8"));
      assert.equal(
        context.sourceDependencyFingerprint,
        fingerprint({
          packageJson: artifact.files["/package.json"],
          pnpmLock: artifact.files["/pnpm-lock.yaml"],
        }),
        `${context.bakedKey}: baked fingerprint drifted from the bucket artifact — rerun scripts/prepare-container.mjs`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `verified ${checked} contexts; expected the container starters of every baked bucket`);
});
