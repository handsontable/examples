import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDocsBranch,
  resolveNpmPackageVersion,
  resolveDocsHotVersion,
} from "./docs-import-config.mjs";

test("normalizes develop to the next bucket", () => {
  assert.deepEqual(normalizeDocsBranch("develop"), {
    docsBranch: "develop",
    bucket: "next",
  });
});

test("normalizes a production docs branch to its release bucket", () => {
  assert.deepEqual(normalizeDocsBranch("prod-docs/18.0"), {
    docsBranch: "prod-docs/18.0",
    bucket: "18.0",
  });
});

test("rejects unsupported and unsafe docs branch names", () => {
  for (const branch of [undefined, "", "18.0", "prod-docs/18", "prod-docs/18.0/../../next"]) {
    assert.throws(() => normalizeDocsBranch(branch), /--docs-branch/);
  }
});

test("uses the checkout package version for a release branch", async () => {
  const version = await resolveDocsHotVersion({
    docsBranch: "prod-docs/18.0",
    docsDir: "/docs",
    readFile: (file) => {
      assert.equal(file, "/handsontable/package.json");
      return JSON.stringify({ version: "18.0.3" });
    },
  });

  assert.equal(version, "18.0.3");
});

test("uses npm dist-tags.next for develop", async () => {
  const version = await resolveDocsHotVersion({
    docsBranch: "develop",
    docsDir: "/docs",
    fetchImpl: async (url) => {
      assert.equal(url, "https://registry.npmjs.org/handsontable");
      return { ok: true, json: async () => ({ "dist-tags": { next: "19.0.0-next.1" } }) };
    },
  });

  assert.equal(version, "19.0.0-next.1");
});

test("resolves a package's concrete latest version from npm", async () => {
  const version = await resolveNpmPackageVersion({
    packageName: "@scope/chart",
    fetchImpl: async (url) => {
      assert.equal(url, "https://registry.npmjs.org/%40scope%2Fchart");
      return { ok: true, json: async () => ({ "dist-tags": { latest: "4.2.1" } }) };
    },
  });

  assert.equal(version, "4.2.1");
});

test("fails when an extra package has no concrete latest version", async () => {
  await assert.rejects(
    resolveNpmPackageVersion({
      packageName: "chart.js",
      fetchImpl: async () => ({ ok: true, json: async () => ({ "dist-tags": { latest: "latest" } }) }),
    }),
    /chart\.js.*dist-tags\.latest/,
  );
});

test("fails when npm does not provide dist-tags.next", async () => {
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({ ok: true, json: async () => ({ "dist-tags": {} }) }),
    }),
    /dist-tags\.next/,
  );
});

test("fails when npm cannot fetch or parse dist-tags.next", async () => {
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /dist-tags\.next/,
  );
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }),
    }),
    /dist-tags\.next/,
  );
});
