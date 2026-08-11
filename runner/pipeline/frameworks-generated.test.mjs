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
