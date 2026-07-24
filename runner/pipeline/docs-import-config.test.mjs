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

// The npm `next` dist-tag went stale on 2026-02-19 while nightlies kept
// publishing daily — every docs example silently pinned a five-month-old
// build, and new-plugin guides (dialog/notification) crashed at runtime.
// Never trust the tag: pick the newest `-next` version by publish date.
test("resolves develop to the newest -next version by publish date, ignoring the stale next tag", async () => {
  const version = await resolveDocsHotVersion({
    docsBranch: "develop",
    docsDir: "/docs",
    fetchImpl: async (url) => {
      assert.equal(url, "https://registry.npmjs.org/handsontable");
      return {
        ok: true,
        json: async () => ({
          // Stale tag points at the February build.
          "dist-tags": { next: "0.0.0-next-64139ae-20260219", latest: "18.0.1" },
          time: {
            created: "2020-01-01T00:00:00.000Z",
            modified: "2026-07-24T09:00:00.000Z",
            "18.0.1": "2026-06-02T10:00:00.000Z",
            // Alphabetically LARGER hash than the July builds — a string or
            // semver-prerelease sort would wrongly pick this one.
            "0.0.0-next-64139ae-20260219": "2026-02-19T04:00:00.000Z",
            "0.0.0-next-9366f60-20260723": "2026-07-23T04:00:00.000Z",
            "0.0.0-next-09631ad-20260724": "2026-07-24T04:00:00.000Z",
          },
        }),
      };
    },
  });

  assert.equal(version, "0.0.0-next-09631ad-20260724");
});

test("ignores non-next versions and the created/modified bookkeeping keys", async () => {
  const version = await resolveDocsHotVersion({
    docsBranch: "develop",
    docsDir: "/docs",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        time: {
          created: "2020-01-01T00:00:00.000Z",
          modified: "2026-07-24T09:00:00.000Z",
          "18.0.1": "2026-07-24T08:00:00.000Z",
          "19.0.0-next.2": "2026-07-01T00:00:00.000Z",
          "0.0.0-next-aaaaaaa-20260601": "2026-06-01T04:00:00.000Z",
        },
      }),
    }),
  });

  // `19.0.0-next.2` (dotted prerelease) counts as a next build too; the
  // stable 18.0.1 published later must not win.
  assert.equal(version, "19.0.0-next.2");
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

test("fails when npm lists no -next versions at all", async () => {
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ time: { created: "2020-01-01T00:00:00.000Z", "18.0.1": "2026-06-02T10:00:00.000Z" } }),
      }),
    }),
    /next version/,
  );
});

test("fails when npm cannot fetch or parse the handsontable registry document", async () => {
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /next version/,
  );
  await assert.rejects(
    resolveDocsHotVersion({
      docsBranch: "develop",
      docsDir: "/docs",
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }),
    }),
    /next version/,
  );
});
