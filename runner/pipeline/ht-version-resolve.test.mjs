// Server-side Handsontable version resolution (DEV-2565).
//
// The defect this covers: both create routes defaulted the column to the literal
// string "latest", which `validateHandsontableVersion` rejects — so the editor
// refused the demo and its silent pin no-op let a bare PR number reach pnpm as a
// registry range. The fix derives a real ref from the payload instead of
// defaulting to a dist-tag, and pins the files server-side.
//
// The load-bearing case is `derives a pkg.pr.new ref from the submitted
// package.json`: resolving the sentinel to npm latest and rewriting would build a
// PR demo against the wrong core, which is worse than the bug being fixed.
//
// Run: node --experimental-strip-types --test pipeline/ht-version-resolve.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  handsontableDependencyRef,
  pinHandsontableFiles,
} from "../packages/runtime/dist/version.js";
import {
  editorVersionRef,
  fetchVersionCatalog,
  resolveHandsontableVersion,
} from "../workers/api/src/ht-version.ts";

const PR_URL = "https://pkg.pr.new/handsontable@13106";

/** A minimal /package.json whose Handsontable dep is `dep`. */
const pkg = (dep, extra = {}) =>
  JSON.stringify(
    {
      name: "demo",
      dependencies: { handsontable: dep, ...(extra.dependencies ?? {}) },
      devDependencies: { vite: "^5.4.0", ...(extra.devDependencies ?? {}) },
    },
    null,
    2,
  ) + "\n";

const filesWith = (dep, extra) => ({ "/package.json": pkg(dep, extra), "/main.js": "//" });

const deps = (files) => JSON.parse(files["/package.json"]).dependencies;
const devDeps = (files) => JSON.parse(files["/package.json"]).devDependencies;

/** Env double: KV-backed `CACHE`, plus a registry document served to global `fetch`
 *  (which is how the Worker reaches npm). `t.after` restores the real one. */
function fakeEnv(t, { latest = "18.0.0", registry = true } = {}) {
  const store = new Map();
  const calls = { registry: 0 };
  const env = {
    CACHE: {
      get: async (key, type) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key, value) => void store.set(key, value),
    },
  };
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.registry += 1;
    if (!registry) throw new Error("registry unreachable");
    return {
      ok: true,
      json: async () => ({
        "dist-tags": { latest, next: "0.0.0-next-stale-20260219" },
        versions: { "17.6.0": {}, "18.0.0": {} },
        time: { "19.0.0-next.4": "2026-08-01T00:00:00.000Z" },
      }),
    };
  };
  t.after(() => { globalThis.fetch = real; });
  return { env, calls };
}

// ---- derivation from the payload -------------------------------------------

test("handsontableDependencyRef reads a pkg.pr.new URL back as its bare ref", () => {
  assert.equal(handsontableDependencyRef(filesWith(PR_URL)), "13106");
});

test("handsontableDependencyRef keeps an exact published version", () => {
  assert.equal(handsontableDependencyRef(filesWith("17.6.0")), "17.6.0");
});

test("handsontableDependencyRef refuses a range or a dist-tag", () => {
  assert.equal(handsontableDependencyRef(filesWith("^18.0.0")), null);
  assert.equal(handsontableDependencyRef(filesWith("latest")), null);
  assert.equal(handsontableDependencyRef({ "/package.json": "{}" }), null);
  assert.equal(handsontableDependencyRef({}), null);
});

test("handsontableDependencyRef ignores an unparseable package.json", () => {
  assert.equal(handsontableDependencyRef({ "/package.json": "{ not json" }), null);
});

// ---- the pin itself ---------------------------------------------------------

test("pinHandsontableFiles is a fixed point on an already-pinned map", () => {
  const once = pinHandsontableFiles(filesWith(PR_URL), { ref: "13106", pkgPrNew: true });
  const twice = pinHandsontableFiles(once, { ref: "13106", pkgPrNew: true });
  assert.equal(deps(once).handsontable, PR_URL);
  assert.equal(twice["/package.json"], once["/package.json"]);
});

test("pinHandsontableFiles leaves devDependencies and the pikaday fork alone", () => {
  const files = filesWith("18.0.0", {
    dependencies: { "@handsontable/pikaday": "1.0.0", "@handsontable/react-wrapper": "18.0.0" },
    devDependencies: { "handsontable-dev-tool": "1.2.3" },
  });
  const pinned = pinHandsontableFiles(files, { ref: "13106", pkgPrNew: true });
  assert.equal(deps(pinned)["@handsontable/pikaday"], "1.0.0");
  assert.equal(
    deps(pinned)["@handsontable/react-wrapper"],
    "https://pkg.pr.new/@handsontable/react-wrapper@13106",
  );
  assert.equal(devDeps(pinned)["handsontable-dev-tool"], "1.2.3");
});

test("pinHandsontableFiles leaves a file map without a package.json untouched", () => {
  const files = { "/main.js": "//" };
  assert.equal(pinHandsontableFiles(files, { ref: "18.0.0", pkgPrNew: false }), files);
});

// ---- resolution: explicit htVersion ----------------------------------------

test("an explicit pkg.pr.new URL is stored as its bare ref and pins the dep", async (t) => {
  const { env } = fakeEnv(t);
  const r = await resolveHandsontableVersion(env, { htVersion: PR_URL, files: filesWith("18.0.0") });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "13106");
  assert.equal(deps(r.files).handsontable, PR_URL);
});

test("an explicit unusable ref is refused with the validator's own message", async (t) => {
  const { env } = fakeEnv(t);
  const r = await resolveHandsontableVersion(env, { htVersion: "18.x-ish", files: filesWith("18.0.0") });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.message, /semver-valid or a pkg\.pr\.new id\/URL/);
});

test("an explicit dist-tag resolves against the registry instead of being stored raw", async (t) => {
  const { env, calls } = fakeEnv(t, { latest: "18.0.0" });
  const r = await resolveHandsontableVersion(env, { htVersion: "latest", files: filesWith("^18.0.0") });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "18.0.0");
  assert.equal(deps(r.files).handsontable, "18.0.0");
  assert.equal(calls.registry, 1);
});

test("the `next` dist-tag resolves to the newest nightly by publish date, not the stale tag", async (t) => {
  const { env } = fakeEnv(t);
  const r = await resolveHandsontableVersion(env, { htVersion: "next", files: filesWith("^18.0.0") });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "19.0.0-next.4");
});

// ---- resolution: derive, don't default -------------------------------------

test("derives a pkg.pr.new ref from the submitted package.json rather than defaulting to latest", async (t) => {
  const { env, calls } = fakeEnv(t, { latest: "18.0.0" });
  const r = await resolveHandsontableVersion(env, { files: filesWith(PR_URL) });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "13106", "the PR build the caller pinned must survive");
  assert.equal(deps(r.files).handsontable, PR_URL);
  assert.equal(calls.registry, 0, "no need to ask npm when the payload already says what it wants");
});

test("derives an exact version from the submitted package.json", async (t) => {
  const { env } = fakeEnv(t);
  const r = await resolveHandsontableVersion(env, { files: filesWith("17.6.0") });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "17.6.0");
});

test("falls back to the previous ref when the payload only carries a range", async (t) => {
  const { env, calls } = fakeEnv(t);
  const r = await resolveHandsontableVersion(env, { files: filesWith("^18.0.0"), previousRef: "13106" });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "13106");
  assert.equal(deps(r.files).handsontable, PR_URL);
  assert.equal(calls.registry, 0);
});

test("ignores a previous ref the validator rejects — that is the sentinel this fixes", async (t) => {
  const { env } = fakeEnv(t, { latest: "18.0.0" });
  const r = await resolveHandsontableVersion(env, { files: filesWith("^18.0.0"), previousRef: "latest" });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "18.0.0");
});

test("resolves npm latest when nothing in the payload says otherwise", async (t) => {
  const { env } = fakeEnv(t, { latest: "18.0.0" });
  const r = await resolveHandsontableVersion(env, { files: filesWith("^18.0.0") });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "18.0.0");
  assert.equal(deps(r.files).handsontable, "18.0.0");
});

test("an unreachable registry is a 502, never a stored dist-tag", async (t) => {
  const { env } = fakeEnv(t, { registry: false });
  const r = await resolveHandsontableVersion(env, { files: filesWith("^18.0.0") });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

// ---- the catalog helper the GET /api/versions handler shares ----------------

test("fetchVersionCatalog caches the registry document in KV", async (t) => {
  const { env, calls } = fakeEnv(t, { latest: "18.0.0" });
  const first = await fetchVersionCatalog(env);
  const second = await fetchVersionCatalog(env);
  assert.equal(first.latest, "18.0.0");
  assert.deepEqual(second, first);
  assert.equal(calls.registry, 1, "second call is served from KV");
});

test("fetchVersionCatalog lists only in-range published releases, newest first", async (t) => {
  const { env } = fakeEnv(t);
  const { versions } = await fetchVersionCatalog(env);
  assert.deepEqual(versions, ["18.0.0", "17.6.0"]);
});

// ---- what the editor is told for a demo saved before this fix ---------------
//
// Rows created before DEV-2565 hold the "latest" sentinel, and the editor turns
// whatever it is handed into its version state (`hadUrlVersion`), so an
// unvalidatable value there is a boot refusal. The source route repairs it from
// the snapshot the row points at, which is cheaper and more honest than a batch
// job: the snapshot is the only place that still knows what the demo was built
// against.

test("editorVersionRef keeps a stored ref the validator accepts", () => {
  assert.equal(editorVersionRef("17.6.0", filesWith("^18.0.0")), "17.6.0");
});

test("editorVersionRef repairs the 'latest' sentinel from the snapshot's own pin", () => {
  assert.equal(editorVersionRef("latest", filesWith(PR_URL)), "13106");
});

test("editorVersionRef gives up when neither the row nor the snapshot names a ref", () => {
  assert.equal(editorVersionRef("latest", filesWith("^18.0.0")), null);
  assert.equal(editorVersionRef(null, {}), null);
});
