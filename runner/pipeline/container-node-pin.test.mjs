// The live and builder images replace the sandbox base image's Node with a
// pinned official tarball. The generator owns the pin; the hand-written builder
// Dockerfile and the generated live Dockerfile must carry the same version,
// checksum and install steps, or one image silently keeps running the older Node.
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

// The RUN instruction that downloads the tarball, with its continuation lines.
const nodeInstallStep = (dockerfile) =>
  /^RUN curl -fsSL -o \/tmp\/node-v[\s\S]*?(?=\n\n|\n[A-Z]+ )/m.exec(read(dockerfile))?.[0];

test("generator declares a Node version and a sha256", () => {
  assert.match(pin.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.match(pin.sha256 ?? "", /^[0-9a-f]{64}$/);
});

for (const dockerfile of ["containers/live/Dockerfile", "containers/builder/Dockerfile"]) {
  test(`${dockerfile} installs the pinned Node tarball with its checksum`, () => {
    const step = nodeInstallStep(dockerfile);
    assert.ok(step, "has a RUN step that downloads the Node tarball");
    const tarball = `node-v${pin.version}-linux-x64.tar.gz`;
    assert.ok(step.includes(`https://nodejs.org/dist/v${pin.version}/${tarball}`), "download URL carries the pinned version");
    assert.ok(step.includes(`${pin.sha256}  /tmp/${tarball}`), "sha256 check carries the pinned checksum");
    assert.ok(step.indexOf("sha256sum -c -") < step.indexOf("tar -xzf"), "checksum is verified before extraction");
    assert.ok(step.includes(`test "$(node -v)" = v${pin.version}`), "build fails unless the active node is the pinned version");
  });
}

test("live and builder run the same Node install step", () => {
  assert.equal(nodeInstallStep("containers/live/Dockerfile"), nodeInstallStep("containers/builder/Dockerfile"));
});
