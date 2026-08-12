// A theme edit must not rebuild the demo (DEV-2496).
//
// Picking a colour in the Style panel wrote the regenerated theme module through the
// ordinary edit path, which on Tier 1 is one full bundler compile — per drag frame.
// The bundler re-evaluates the sandbox on every compile, so the grid was rebuilt
// thirty times a second: the "blink blink" the panel was reported for.
//
// The fix splits "keep the file" from "rebuild the preview". The panel patches the
// running theme object over postMessage and writes the file quietly; the write is
// still a write — Download, Share, Save and Refresh must all see the current theme —
// it just does not compile. This file pins that contract on both engines, because a
// quiet write that quietly *lost* the file would be a much worse bug than the blink.

import test from "node:test";
import assert from "node:assert/strict";
import { SandpackRuntime } from "../packages/runtime/dist/sandpack.js";
import { ContainerRuntime } from "../packages/runtime/dist/container.js";

const ENTRY = {
  framework: "vue",
  displayName: "Vue",
  tier: 1,
  engine: "sandpack",
  sandpackTemplate: "vue",
  sandpackEnvironment: "vue-cli",
  container: null,
  htWrappers: [],
  entry: "/src/main.js",
  htmlEntry: null,
  devCommand: null,
  buildCommand: "build",
  outputDir: "dist",
  outputGlob: null,
  staticExport: false,
  spaMode: false,
  port: null,
  installCommand: "install",
  htCoreRange: null,
  minCoreMajor: null,
  fileCount: 2,
  assets: [],
  skipped: [],
  files: {},
};

const FILES = {
  "/package.json": JSON.stringify({ dependencies: { handsontable: "16.0.1" } }),
  "/src/main.js": "console.log('demo');",
};

const THEME = "/handsontable-theme.js";

/** Stand in for the mounted sandpack client and record every compile push. */
function fakeClient() {
  const pushes = [];
  return {
    pushes,
    updateSandbox(setup, isInitializationCompile) {
      pushes.push({ setup, isInitializationCompile });
    },
    listen() {
      return () => {};
    },
    destroy() {},
  };
}

/** A Tier-1 runtime with a client attached, skipping mount() (needs a DOM + bundler). */
function mountedSandpack() {
  const runtime = new SandpackRuntime(ENTRY, { iframe: {} });
  const client = fakeClient();
  runtime.client = client;
  runtime.files = { ...FILES };
  runtime.published = { ...FILES };
  return { runtime, client };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a quiet write does not compile", async () => {
  const { runtime, client } = mountedSandpack();

  runtime.writeFile(THEME, "export const customTheme = 1;", { quiet: true });
  await settle();

  assert.equal(
    client.pushes.length,
    0,
    "a theme edit the panel has already applied over the bridge must not rebuild the demo",
  );
});

test("a quiet write is still a write", async () => {
  const { runtime } = mountedSandpack();

  runtime.writeFile(THEME, "export const customTheme = 1;", { quiet: true });

  assert.equal(
    runtime.files[THEME],
    "export const customTheme = 1;",
    "the file has to be there for Download, Share and Save — only the compile waits",
  );
});

test("the next ordinary edit carries the quiet writes with it", async () => {
  const { runtime, client } = mountedSandpack();

  runtime.writeFile(THEME, "export const customTheme = 1;", { quiet: true });
  runtime.writeFile("/src/main.js", "console.log('edited');");
  await settle();

  assert.equal(client.pushes.length, 1, "one compile, for the pair of them");
  const files = client.pushes[0].setup.files;
  assert.equal(files[THEME].code, "export const customTheme = 1;");
  assert.equal(files["/src/main.js"].code, "console.log('edited');");
});

test("flushQuiet() compiles what was held back", async () => {
  const { runtime, client } = mountedSandpack();

  runtime.writeFile(THEME, "export const customTheme = 1;", { quiet: true });
  runtime.flushQuiet();
  await settle();

  assert.equal(client.pushes.length, 1, "the panel's fallback has to reach the bundler");
  assert.equal(client.pushes[0].setup.files[THEME].code, "export const customTheme = 1;");
});

test("flushQuiet() with nothing held back does not compile", async () => {
  const { runtime, client } = mountedSandpack();

  runtime.flushQuiet();
  await settle();

  // Not an optimisation: a byte-identical compile resets the preview document without
  // re-evaluating anything, which is the blank preview `pushUpdate`'s no-op check exists
  // to prevent. A fallback that fires after a *successful* patch must be free.
  assert.equal(client.pushes.length, 0, "a no-op flush must not blank the preview");
});

test("refresh serves the theme the panel is showing", async () => {
  const { runtime, client } = mountedSandpack();

  runtime.writeFile(THEME, "export const customTheme = 1;", { quiet: true });
  await runtime.reload();

  assert.equal(
    client.pushes.at(-1).setup.files[THEME].code,
    "export const customTheme = 1;",
    "a refresh rebuilds from the files, so it must not fall back to a pre-drag theme",
  );
});

// ---- Tier 2 ---------------------------------------------------------------
//
// Same contract, different cost: there a write goes to a container dev server and the
// page reloads, which loses the grid's scroll and selection outright.

/** A container runtime with a session and the network stubbed. `mounted: false` is the
 *  window between the create POST going out and the session accepting writes. */
function mountedContainer({ mounted = true } = {}) {
  const posts = [];
  const runtime = new ContainerRuntime(
    { ...ENTRY, engine: "container", tier: 2, container: "vue" },
    { iframe: {}, apiBase: "https://api.test" },
  );
  runtime.sessionId = "s1";
  runtime.mounted = mounted;
  runtime.files = { ...FILES };
  globalThis.fetch = (url, init) => {
    posts.push(JSON.parse(init.body));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };
  return { runtime, posts };
}

test("a quiet write reaches neither the dev server nor the timer", async () => {
  const fetchBefore = globalThis.fetch;
  const { runtime, posts } = mountedContainer();
  try {
    runtime.writeFile(THEME, "export const customTheme = 1;", { quiet: true });
    await settle();

    assert.deepEqual(posts, [], "streaming it would reload the page — the worst version of this bug");
    assert.equal(runtime.files[THEME], "export const customTheme = 1;", "the file is still kept");
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("a quiet write made while the session is still being created is not lost", async () => {
  // The panel reconciles a theme restored from localStorage the moment it opens, and a
  // container takes tens of seconds to come up — so this window is ordinary, not exotic.
  // Nothing else would deliver the file either: there is no bridge until the demo has
  // run, and `flush()` refuses to stream before the session accepts writes. So mount()
  // has to drain the quiet writes, exactly as it already drains the ordinary ones.
  //
  // Driven through the real mount() rather than by flipping `mounted` by hand: the bug
  // this covers was in mount()'s own "is there anything buffered?" test, which a
  // hand-flipped flag walks straight past.
  const fetchBefore = globalThis.fetch;
  const windowBefore = globalThis.window;
  const posts = [];
  let releaseCreate;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = (url, init = {}) => {
    if (url.endsWith("/api/session")) {
      return new Promise((resolve) => {
        releaseCreate = () => resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ previewUrl: "https://preview.test/", port: 4321 }),
        });
      });
    }
    if (url.includes("/file")) posts.push(JSON.parse(init.body));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  };

  const runtime = new ContainerRuntime(
    { ...ENTRY, engine: "container", tier: 2, container: "vue" },
    { iframe: {}, apiBase: "https://api.test" },
  );
  try {
    const mounting = runtime.mount({ ...FILES });
    await settle();

    // Mid-create: the id exists, the session does not yet.
    runtime.writeFile(THEME, "export const customTheme = 1;", { quiet: true });
    assert.deepEqual(posts, [], "nothing can be streamed before the session accepts writes");

    releaseCreate();
    await mounting;
    await settle();

    assert.deepEqual(
      posts.map((p) => p.path),
      ["handsontable-theme.js"],
      "the buffered theme has to go out as soon as the session is up",
    );
  } finally {
    runtime.dispose();
    globalThis.fetch = fetchBefore;
    globalThis.window = windowBefore;
  }
});

test("a container refresh streams the held-back theme first", async () => {
  const fetchBefore = globalThis.fetch;
  const { runtime, posts } = mountedContainer();
  try {
    runtime.writeFile(THEME, "export const customTheme = 1;", { quiet: true });
    // `reload()` navigates the iframe; give it one that reports a load immediately.
    runtime.pointed = true;
    runtime.previewUrl = "https://preview.test/";
    runtime.opts.iframe = {
      addEventListener: (_event, cb) => cb(),
      removeEventListener: () => {},
      set src(_value) {},
    };

    await runtime.reload();

    assert.deepEqual(
      posts.map((p) => p.path),
      ["handsontable-theme.js"],
      "the write has to land before the navigation, or the reloaded page serves the pre-drag theme",
    );
  } finally {
    globalThis.fetch = fetchBefore;
  }
});
