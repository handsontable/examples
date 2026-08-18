// Shape guard for the generated FRAMEWORK_DEV contexts (DEV-2213): the API
// worker selects a baked context by dependency fingerprint and falls back to
// defaultBakedKey, so a malformed regeneration must fail here, not at session
// boot. Run: node --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { FRAMEWORK_DEV, BUILD_CONFIG } from "../workers/api/src/frameworks.generated.ts";
import { dependencyMetadataFingerprint } from "../workers/api/src/dependency-metadata.ts";

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
    // Single-seed image: every context must point at a bakedKey that exists in
    // the image, and only the seed contexts are baked.
    for (const c of dev.contexts) {
      assert.equal(c.bakedKey, dev.defaultBakedKey, `${framework}/${c.bucket}: context seeds the framework's baked key`);
      assert.equal(typeof c.bucket, "string");
    }
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

test("BUILD_CONFIG matches catalog.json field for field", async () => {
  // Coverage alone let a stale regeneration through: the blank starters shipped
  // with `pnpm install` in this map while catalog.json (and frameworks.json) said
  // `--frozen-lockfile`, so their snapshot builds silently skipped the frozen
  // install the templates ship a lockfile to enforce. The generator's output has
  // to equal its source, not merely mention the same keys.
  const fs = await import("node:fs");
  const catalog = JSON.parse(fs.readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
  for (const e of catalog.examples) {
    assert.deepEqual(
      BUILD_CONFIG[e.framework],
      {
        tier: e.tier,
        installCommand: e.installCommand,
        buildCommand: e.buildCommand,
        outputDir: e.outputDir,
        outputGlob: e.outputGlob ?? null,
      },
      `${e.framework}: drifted from catalog.json — rerun scripts/prepare-container.mjs`,
    );
  }
});

test("baked fingerprints match the bucket artifacts they were derived from", async () => {
  // The frozen fast path only opens when the client's mounted files hash to a
  // baked fingerprint — and on a match the boot script hard-fails instead of
  // retrying non-frozen. Regenerating buckets without prepare-container (or
  // vice versa) would silently break that invariant; catch the drift here.
  //
  // Hashed with `dependencyMetadataFingerprint` — the export the Worker's
  // runtime match uses (`index.ts`) — and NOT a local re-implementation: the
  // committed fingerprints come from `prepare-container.mjs`'s own copy of the
  // preimage, so a test carrying a third copy would agree with the generator
  // and stay green while the canonical preimage drifted — with every session
  // silently falling off the frozen path. Only the canonical function can call
  // that drift out. (`prepare-container.mjs` still keeps its private copy — it
  // runs under plain `node`, where the `.ts` import doesn't resolve; this test
  // is the tripwire for the generator's copy drifting too.)
  const fs = await import("node:fs");

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
      const artifactUrl = new URL(`${context.bucket}/${framework}.json`, bucketsDir);
      assert.ok(
        fs.existsSync(artifactUrl),
        `${framework}/${context.bucket}: context refers to a bucket artifact that does not exist`,
      );
      const artifact = JSON.parse(fs.readFileSync(artifactUrl, "utf8"));
      assert.equal(
        context.sourceDependencyFingerprint,
        await dependencyMetadataFingerprint({
          packageJson: artifact.files["/package.json"],
          pnpmLock: artifact.files["/pnpm-lock.yaml"],
        }),
        `${framework}/${context.bucket}: fingerprint drifted from the bucket artifact — rerun scripts/prepare-container.mjs`,
      );
      checked += 1;
    }
  }
  // 11 container starters × their eligible buckets (5 unfloored, angular 4,
  // the five 17-floored 3 each) = 44.
  assert.ok(checked >= 40, `verified ${checked} contexts; expected every (container starter, bucket) pair`);
});
