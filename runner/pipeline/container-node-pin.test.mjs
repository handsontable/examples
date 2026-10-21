// The Tier-2 images replace the sandbox base image's Node with a pinned
// official tarball. The generator owns the pin; the hand-written builder
// Dockerfile and the generated live Dockerfile must carry the same version and
// checksum, or one image silently keeps running the older Node.
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(RUNNER_DIR, rel), "utf8");

const generator = read("scripts/prepare-container.mjs");
const pin = {
  version: /const NODE_VERSION = "([^"]+)"/.exec(generator)?.[1],
  sha256: /const NODE_SHA256 = "([0-9a-f]{64})"/.exec(generator)?.[1],
};

test("generator declares a Node version and a sha256", () => {
  assert.match(pin.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.match(pin.sha256 ?? "", /^[0-9a-f]{64}$/);
});

for (const dockerfile of ["containers/live/Dockerfile", "containers/builder/Dockerfile"]) {
  test(`${dockerfile} installs the pinned Node tarball with its checksum`, () => {
    const source = read(dockerfile);
    const tarball = `node-v${pin.version}-linux-x64.tar.gz`;
    assert.ok(source.includes(`https://nodejs.org/dist/v${pin.version}/${tarball}`), "download URL carries the pinned version");
    assert.ok(source.includes(`${pin.sha256}  /tmp/${tarball}`), "sha256 check carries the pinned checksum");
    assert.ok(source.includes("sha256sum -c -"), "checksum is verified before extraction");
  });
}
