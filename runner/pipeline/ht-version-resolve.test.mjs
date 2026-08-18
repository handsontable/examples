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
import { MAX_MCP_BYTES, isMcpValidationError, validateMcpFiles } from "../workers/api/src/mcp-create.ts";

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
function fakeEnv(t, { latest = "18.0.0", registry = true, status = 200 } = {}) {
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
      delete: async (key) => void store.delete(key),
    },
  };
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.registry += 1;
    if (!registry) throw new Error("registry unreachable");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        "dist-tags": { ...(latest ? { latest } : {}), next: "0.0.0-next-stale-20260219" },
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

test("handsontableDependencyRef keeps a bare pkg.pr.new id — the DEMOS-1X shape", () => {
  assert.equal(handsontableDependencyRef(filesWith("13106")), "13106");
});

test("handsontableDependencyRef refuses a range or a dist-tag", () => {
  assert.equal(handsontableDependencyRef(filesWith("^18.0.0")), null);
  assert.equal(handsontableDependencyRef(filesWith("~18.0.0")), null);
  assert.equal(handsontableDependencyRef(filesWith(">=17")), null);
  assert.equal(handsontableDependencyRef(filesWith("latest")), null);
  assert.equal(handsontableDependencyRef({ "/package.json": "{}" }), null);
  assert.equal(handsontableDependencyRef({}), null);
});

test("handsontableDependencyRef refuses a partial version, which npm reads as a range", () => {
  // "18" is any 18.x and "18.0" any 18.0.x. Deriving 18.0.0 from either would
  // pin the demo *down* from whatever npm would have installed.
  assert.equal(handsontableDependencyRef(filesWith("18")), null);
  assert.equal(handsontableDependencyRef(filesWith("18.0")), null);
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

test("a dist-tag never outranks the pin the payload carries", async (t) => {
  // `MyDemos`'s fork forwards the row's `ht_version` verbatim, so a legacy demo
  // forks with htVersion: "latest". A tag names a moving target — the same
  // non-answer a range is — so it must not rewrite a payload that pins a build.
  const { env, calls } = fakeEnv(t, { latest: "18.0.0" });
  const r = await resolveHandsontableVersion(env, { htVersion: "latest", files: filesWith(PR_URL) });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "13106");
  assert.equal(deps(r.files).handsontable, PR_URL);
  assert.equal(calls.registry, 0);
});

test("on the service path an explicit dist-tag is the caller's intent and does outrank the payload", async (t) => {
  // The service path has no forwarding hazard: hot-mcp sends only what the model
  // passed, never a stored `ht_version`. So a tag there is a fresh request, and
  // ignoring it would leave a machine caller with no way to move a demo off a PR
  // build — silently, since nothing said the tag lost (review of PR #230).
  const { env } = fakeEnv(t, { latest: "18.0.0" });
  const r = await resolveHandsontableVersion(env, {
    htVersion: "latest",
    files: filesWith(PR_URL),
    trustDistTag: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "18.0.0");
  assert.equal(deps(r.files).handsontable, "18.0.0");
});

test("a dist-tag still outranks the demo's previous ref", async (t) => {
  const { env } = fakeEnv(t, { latest: "18.0.0" });
  const r = await resolveHandsontableVersion(env, {
    htVersion: "latest",
    files: filesWith("^18.0.0"),
    previousRef: "17.6.0",
  });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "18.0.0");
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

test("normalises the bare PR number that produced DEMOS-1X into a pkg.pr.new install", async (t) => {
  // The exact save that failed: a hand-typed PR ref in package.json, no explicit
  // htVersion, and a row still holding the sentinel. pnpm saw handsontable@13106
  // as a registry range; it must see the pkg.pr.new tarball instead.
  const { env } = fakeEnv(t);
  const r = await resolveHandsontableVersion(env, { files: filesWith("13106"), previousRef: "latest" });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "13106");
  assert.equal(deps(r.files).handsontable, PR_URL);
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

test("fetchVersionCatalog refuses a non-200 registry response instead of caching an empty catalog", async (t) => {
  // A cached `{latest:null}` would answer for an hour, and since DEV-2565 the
  // catalog gates demo creation, not just the version dropdown: every create
  // that falls through to npm latest would 502 for that hour.
  const { env, calls } = fakeEnv(t, { status: 503 });
  await assert.rejects(() => fetchVersionCatalog(env), /registry/i);
  await assert.rejects(() => fetchVersionCatalog(env));
  assert.equal(calls.registry, 2, "nothing was cached, so the second call retries npm");
});

test("fetchVersionCatalog does not cache a document with no latest dist-tag", async (t) => {
  // The picker can still degrade on a catalog like this, so it is returned — but
  // caching it would answer for the whole TTL, and demo creation now depends on
  // the answer.
  const { env, calls } = fakeEnv(t, { latest: null });
  const first = await fetchVersionCatalog(env);
  assert.equal(first.latest, null);
  await fetchVersionCatalog(env);
  assert.equal(calls.registry, 2, "nothing was cached, so the second call retries npm");
});

test("fetchVersionCatalog ignores a degenerate catalog already in KV", async (t) => {
  // Exactly what master leaves behind: it cached whatever npm returned, including
  // an error body parsed as `{latest:null}`. That entry outlives this deploy.
  const { env, calls } = fakeEnv(t, { latest: "18.0.0" });
  await env.CACHE.put("versions", JSON.stringify({ latest: null, next: null, versions: [] }));
  const catalog = await fetchVersionCatalog(env);
  assert.equal(catalog.latest, "18.0.0");
  assert.equal(calls.registry, 1);
});

test("a demo create still resolves latest with a degenerate catalog in KV", async (t) => {
  const { env } = fakeEnv(t, { latest: "18.0.0" });
  await env.CACHE.put("versions", JSON.stringify({ latest: null, next: null, versions: [] }));
  const r = await resolveHandsontableVersion(env, { files: filesWith("^18.0.0") });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "18.0.0");
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

// ---- npm being unreachable must not refuse a demo ---------------------------
//
// Review of PR #230: resolving `latest` server-side made npm availability a
// dependency of demo *creation*, where before it only degraded the version
// dropdown. A payload carrying nothing but ranges — the shape hot-mcp's tool
// description asks the model for — would 502 on a registry hiccup, reaching MCP
// callers as "the runner refused your demo".

test("a registry outage falls back to the last latest npm was known to have", async (t) => {
  const { env } = fakeEnv(t, { latest: "18.0.0" });
  await fetchVersionCatalog(env); // one good day, which is what records it
  const { env: down } = fakeEnv(t, { registry: false });
  down.CACHE = env.CACHE; // same namespace, and the hour-long catalog has expired
  await down.CACHE.delete("versions");

  const r = await resolveHandsontableVersion(down, { files: filesWith("^18.0.0") });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "18.0.0");
  assert.equal(deps(r.files).handsontable, "18.0.0");
});

test("a registry outage with nothing remembered is still a 502", async (t) => {
  const { env } = fakeEnv(t, { registry: false });
  const r = await resolveHandsontableVersion(env, { files: filesWith("^18.0.0") });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});

// ---- the byte cap has to hold on what is stored, not what was sent ----------

test("pinning can push a payload that passed the cap over it", async (t) => {
  // Why the MCP handlers re-validate after resolving: the pin re-serialises
  // /package.json at two-space indent and swaps ranges for pkg.pr.new URLs, and
  // both only grow it. Re-indenting a minified manifest is the unbounded half.
  const manifest = JSON.stringify({
    name: "demo",
    dependencies: Object.fromEntries([
      ["handsontable", "18.0.0"],
      ...Array.from({ length: 400 }, (_, i) => [`pkg-${i}`, "1.0.0"]),
    ]),
  });
  const filler = "x".repeat(MAX_MCP_BYTES - manifest.length - 32);
  const files = { "/package.json": manifest, "/filler.js": filler };

  const accepted = validateMcpFiles(files);
  assert.equal(isMcpValidationError(accepted), false, "the payload as sent is under the cap");

  const { env } = fakeEnv(t);
  const r = await resolveHandsontableVersion(env, { htVersion: "13106", files });
  assert.equal(r.ok, true);
  const refused = validateMcpFiles(r.files);
  assert.equal(isMcpValidationError(refused), true, "the pinned payload is over it");
  assert.match(refused.error, /files too large/);
});
