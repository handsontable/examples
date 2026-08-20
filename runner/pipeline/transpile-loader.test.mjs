import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPILER_UNAVAILABLE_MESSAGE,
  CompilerUnavailableError,
  asBabel,
  assetUrlFrom,
  createLazyLoader,
  createRetryingLoader,
  isCompilerUnavailable,
} from "../packages/runtime/dist/transpile.js";

// DEMOS-15 / DEV-2569. `@babel/standalone` is code-split and fetched on first Tier-1
// compile. The loader cached the *promise*, so one failed fetch was remembered for the life
// of the page and Tier 1 could not compile anything until reload.
//
// Evicting that memo is necessary and, alone, inert — a browser caches a failed module
// fetch in the module map, so re-importing the same specifier never touches the network
// again. Measured in Chromium 141 (@playwright/test 1.61.1), aborting `chunk.js` and then
// serving it:
//
//   attempt 1  ./chunk.js           -> TypeError       1 request
//   attempt 2  ./chunk.js           -> same TypeError  1 request  (no refetch)
//   attempt 3  ./chunk.js, now 200  -> same TypeError  1 request  (still no refetch)
//   attempt 4  ./chunk.js?retry=1   -> module          2 requests
//
// So the retry has to ask for a URL the module map has not seen. That is what the
// `retryOf` argument is for, and the assertions below are what keep it that way.
//
// The real `loadBabel` cannot be driven into failure from here (the dependency is
// installed, so the import resolves), which is why both rules are their own exports.

const FETCH_FAILED = "Failed to fetch dynamically imported module";
const CHUNK = "https://demos.handsontable.com/assets/babel-CRE6e0VF.js";
const moduleLoadError = (url = CHUNK) => new TypeError(`${FETCH_FAILED}: ${url}`);
const wrap = (cause, opts) => new CompilerUnavailableError(cause, opts);

test("a failed load is retried, not remembered", () => {
  let calls = 0;
  const load = createLazyLoader(async () => {
    calls += 1;
    if (calls === 1) throw moduleLoadError();
    return "babel";
  });

  return assert.rejects(load(), /Failed to fetch/).then(async () => {
    assert.equal(await load(), "babel", "the next compile must be able to succeed");
    assert.equal(calls, 2);
  });
});

test("a successful load is shared, not repeated", () => {
  // The reason to cache at all: the chunk is ~3 MB, and a workspace compiles several
  // files at once.
  let calls = 0;
  const load = createLazyLoader(async () => {
    calls += 1;
    return "babel";
  });

  return Promise.all([load(), load(), load()]).then(async (results) => {
    assert.deepEqual(results, ["babel", "babel", "babel"]);
    assert.equal(await load(), "babel");
    assert.equal(calls, 1);
  });
});

test("concurrent callers of a failing load share the one attempt", () => {
  let calls = 0;
  const load = createLazyLoader(async () => {
    calls += 1;
    throw new Error("offline");
  });

  return Promise.allSettled([load(), load()]).then((settled) => {
    assert.deepEqual(settled.map((s) => s.status), ["rejected", "rejected"]);
    assert.equal(calls, 1);
  });
});

test("assetUrlFrom reads the URL out of the engine's own wording, or nothing", () => {
  assert.equal(assetUrlFrom(moduleLoadError()), CHUNK);
  // Safari names no URL. A retry is impossible then, which is what makes the first failure
  // terminal rather than a bug in this parse.
  assert.equal(assetUrlFrom(new TypeError("Load failed")), null);
  assert.equal(assetUrlFrom("Failed to fetch dynamically imported module: " + CHUNK), CHUNK);
  assert.equal(assetUrlFrom(null), null);
});

test("the retry asks for a different URL than the one that just failed", async () => {
  const asked = [];
  const { load } = createRetryingLoader(
    async () => {
      asked.push(CHUNK);
      throw moduleLoadError();
    },
    (cause, generation) => {
      const url = assetUrlFrom(cause);
      if (!url) return null;
      asked.push(`${url}?hotRetry=${generation + 1}`);
      return Promise.resolve("babel");
    },
    wrap,
  );

  assert.equal(await load(), "babel", "a blip that has passed must recover");
  assert.deepEqual(asked, [CHUNK, `${CHUNK}?hotRetry=1`]);
  assert.notEqual(asked[0], asked[1], "re-importing the same specifier never refetches");
});

test("both attempts failing becomes a CompilerUnavailableError", async () => {
  const cause = moduleLoadError();
  const { load } = createRetryingLoader(
    async () => {
      throw cause;
    },
    () => Promise.reject(cause),
    wrap,
  );

  const e = await load().then(
    () => null,
    (err) => err,
  );
  assert.ok(isCompilerUnavailable(e), "the marker is how the app and the runtime recognise it");
  assert.equal(e.name, "CompilerUnavailableError");
  assert.equal(e.message, COMPILER_UNAVAILABLE_MESSAGE, "a constant message is a stable Sentry title");
  assert.equal(e.assetUrl, CHUNK, "the sample rides beside the message, never inside it");
  // Own property, not just a declaration: `App.tsx` reads it off the caught error with a
  // cast (`(e as { assetUrl?: string | null }).assetUrl`) to reach `extra.assetUrl`, and a
  // field that survived only in the .d.ts would make that read undefined in production.
  assert.ok(Object.hasOwn(e, "assetUrl"));
  assert.ok(!e.message.includes(CHUNK), "the URL in the title is what made DEMOS-15 name one sample");
  assert.equal(e.cause, cause);
  assert.equal(e.replay, false, "the throw that discovered the failure is the one worth reporting");
});

test("a cause naming no URL is terminal on the first failure, with no second attempt", async () => {
  let retries = 0;
  const { load } = createRetryingLoader(
    async () => {
      throw new TypeError("Load failed");
    },
    () => {
      retries += 1;
      return null;
    },
    wrap,
  );

  const e = await load().catch((err) => err);
  assert.ok(isCompilerUnavailable(e));
  assert.equal(e.assetUrl, null);
  assert.equal(retries, 1, "the retry was offered the cause and declined it — not skipped");
});

test("the failure latches: no further attempts, and later throws are replays", async () => {
  let calls = 0;
  const { load } = createRetryingLoader(
    async () => {
      calls += 1;
      throw moduleLoadError();
    },
    (cause) => {
      calls += 1;
      return Promise.reject(cause);
    },
    wrap,
  );

  const first = await load().catch((e) => e);
  assert.equal(calls, 2, "one load, one retry");
  assert.equal(first.replay, false);

  const second = await load().catch((e) => e);
  assert.equal(calls, 2, "a latched compiler must not spend the visitor's bandwidth per keystroke");
  assert.equal(second.replay, true, "so the shell can report the discovery and not every keystroke");
  assert.equal(second.assetUrl, CHUNK, "a replay still knows which asset it was");
});

test("rearm buys one more pair of attempts, with a fresh retry URL", async () => {
  // Wired to *Restart preview*: a visitor whose network came back must not have to reload
  // and lose unsaved edits. The generation is what makes the click a real request rather
  // than a module-map replay of a decided failure.
  const asked = [];
  let offline = true;
  const { load, rearm } = createRetryingLoader(
    createLazyLoader(async () => {
      asked.push(CHUNK);
      throw moduleLoadError();
    }),
    (cause, generation) => {
      const spec = `${assetUrlFrom(cause)}?hotRetry=${generation + 1}`;
      asked.push(spec);
      return offline ? Promise.reject(cause) : Promise.resolve("babel");
    },
    wrap,
  );

  await assert.rejects(load(), (e) => isCompilerUnavailable(e));
  await assert.rejects(load(), (e) => e.replay === true);
  assert.deepEqual(asked, [CHUNK, `${CHUNK}?hotRetry=1`], "the latch held");

  offline = false;
  rearm();
  assert.equal(await load(), "babel");
  assert.equal(asked.at(-1), `${CHUNK}?hotRetry=2`, "a rearmed retry must not reuse a poisoned URL");
  assert.equal(await load(), "babel", "and the loader is healthy again afterwards");
});

test("isCompilerUnavailable is a marker check, not a message sniff", () => {
  assert.equal(isCompilerUnavailable(new CompilerUnavailableError(moduleLoadError())), true);
  assert.equal(isCompilerUnavailable(new SyntaxError("Unexpected token")), false);
  assert.equal(
    isCompilerUnavailable(new Error(COMPILER_UNAVAILABLE_MESSAGE)),
    false,
    "a mid-edit parse error must keep pushUpdate's silence even if it says the words",
  );
  assert.equal(isCompilerUnavailable(null), false);
  assert.equal(isCompilerUnavailable("compiler"), false);
});

// DEV-2569, second pass. The retry mechanism above was shipped and did not recover: it
// resolved, and the next compile died as `e.transform is not a function`.
//
// The two import sites in transpile.ts are byte-identical in source and are not identical in
// the bundle. Vite rewrites only the bare specifier, and @babel/standalone is CJS, so the
// primary gets an interop hop that `@vite-ignore` suppresses on the retry. Measured in the
// deployed bundle (/assets/index-uxATgr1X.js, 2026-08-20):
//
//   primary:  import("./babel-<hash>.js").then(t => t.b).then(t => t.default ?? t)
//   retry:    import(`${url}?hotRetry=1`).then(o => o.default ?? o)
//
// and the chunk exported only that wrapper — `export { Hke as b }`, Hke being Vite's
// `_mergeNamespaces({__proto__: null, default: babel}, [cjs])`. So the retry resolved the raw
// record `{b: {…}}` and `m.default ?? m` returned the record itself. In-page probe against
// that bundle: nsKeys ["b"], hasTransform "undefined", viaB "function".
//
// None of this is visible from here — these tests import `packages/runtime/dist`, where both
// paths really are equivalent, which is why the ten tests above were green over a broken
// retry. What *is* testable from here is the rule that makes the shapes interchangeable, so
// these cases fix the three measured shapes as the contract. The bundle itself is pinned by
// `scripts/check-compiler-chunk.mjs` and by preview-recovery.spec.ts, which run against a build.

/** Stands in for the babel object. Identity is the assertion: `asBabel` must return *this*,
 *  not some wrapper that merely happens to expose a `transform`. */
const babelStub = { transform: () => ({ code: "" }) };

/** A module namespace: null-prototype and frozen, the way both bundlers and the engine make
 *  them — a plain object would let a `default` lookup fall through to Object.prototype. */
const ns = (props) => Object.freeze({ __proto__: null, ...props });

test("asBabel resolves the shape the bundled retry receives (no interop hop)", () => {
  const record = ns({ b: ns({ default: babelStub, transform: babelStub.transform }) });
  assert.equal(asBabel(record), babelStub, "the wrapper is not the compiler");
});

test("asBabel does not depend on the bundler's export name", () => {
  // `b` is Rollup's, pinned by nothing. A rename must not strand the retry again.
  assert.equal(asBabel(ns({ zQ7: ns({ default: babelStub }) })), babelStub);
});

test("asBabel keeps resolving the two shapes that already worked", () => {
  // The bundled primary, after Vite's `.then(t => t.b)` hop.
  assert.equal(asBabel(ns({ default: babelStub })), babelStub);
  // Node/dist, where the namespace re-exports the CJS members alongside `default`.
  assert.equal(
    asBabel(ns({ default: babelStub, transform: babelStub.transform })),
    babelStub,
    "`default` is preferred at every level, so the primary path resolves what it does today",
  );
});

test("a module with no transform() is a compiler failure, and keeps its URL", async () => {
  // The SPA fallback answers a rotated chunk with `200 text/html`; a module that parses but
  // exposes no compiler is the same class of event. It must not be left to surface downstream
  // inside babel.transform, where tier1Report files it in the visitor-source bucket as if it
  // were a typo — that is what this defect did in production.
  const { load } = createRetryingLoader(
    async () => asBabel(ns({}), CHUNK),
    () => null,
    wrap,
  );

  const e = await load().catch((err) => err);
  assert.ok(isCompilerUnavailable(e), "ours to fix, not the visitor's");
  assert.equal(e.message, COMPILER_UNAVAILABLE_MESSAGE);
  assert.equal(e.assetUrl, CHUNK, "the URL has to ride in the thrown message to survive here");
});

test("a bad-shape resolution is retried against a fresh URL and recovers", async () => {
  // The whole point: the retry now yields a usable compiler instead of a wrapper.
  const asked = [];
  const { load } = createRetryingLoader(
    async () => {
      asked.push(CHUNK);
      return asBabel(ns({}), CHUNK);
    },
    (cause, generation) => {
      const url = assetUrlFrom(cause);
      if (!url) return null;
      const spec = `${url}?hotRetry=${generation + 1}`;
      asked.push(spec);
      return Promise.resolve(asBabel(ns({ b: ns({ default: babelStub }) }), spec));
    },
    wrap,
  );

  assert.equal(await load(), babelStub);
  assert.deepEqual(asked, [CHUNK, `${CHUNK}?hotRetry=1`]);
});
