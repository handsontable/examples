import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPILER_UNAVAILABLE_MESSAGE,
  CompilerUnavailableError,
  createBoundedLoader,
  createLazyLoader,
  isCompilerUnavailable,
} from "../packages/runtime/dist/transpile.js";

// DEMOS-15 / DEV-2569. `@babel/standalone` is code-split and fetched on first Tier-1
// compile. The loader cached the *promise*, so a single failed fetch — offline, blocked,
// or a deploy that rotated the hashed asset name out from under an already-open tab —
// was remembered for the life of the page: every later compile re-awaited the same
// rejection and reported another "Failed to fetch dynamically imported module".
//
// The real `loadBabel` cannot be driven into failure from here (the dependency is
// installed, so the import resolves), which is why both rules are their own exports.

test("a failed load is retried, not remembered", () => {
  let calls = 0;
  const load = createLazyLoader(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch dynamically imported module");
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
  // The slot is cleared inside the rejection handler, which runs after every caller
  // already holds the same promise — so a burst of compiles costs one fetch, and the
  // retry belongs to whatever comes next.
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

// The retry above is necessary but not sufficient: the observed DEMOS-15 events carry
// two different `babel-<hash>.js` names on two different releases, and Workers Assets
// keeps only the current build (`not_found_handling: "single-page-application"`), so a
// stale tab's chunk is gone for good. Re-importing the same specifier can never
// succeed, and unbounded retrying would burn 3 MB and file an event per keystroke.

test("one transient failure still resolves, without the caller seeing it", async () => {
  let calls = 0;
  const { load } = createBoundedLoader(
    async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch dynamically imported module");
      return "babel";
    },
    () => new Error("should not be reached"),
  );

  assert.equal(await load(), "babel");
  assert.equal(calls, 2, "the second attempt is a real refetch");
});

test("two failures in one call become a CompilerUnavailableError", async () => {
  const url = "https://demos.handsontable.com/assets/babel-CRE6e0VF.js";
  const cause = new TypeError(`Failed to fetch dynamically imported module: ${url}`);
  const { load } = createBoundedLoader(
    async () => {
      throw cause;
    },
    (c) => new CompilerUnavailableError(c),
  );

  const e = await load().then(
    () => null,
    (err) => err,
  );
  assert.ok(isCompilerUnavailable(e), "the marker is how the app and the runtime recognise it");
  assert.equal(e.name, "CompilerUnavailableError");
  assert.equal(e.message, COMPILER_UNAVAILABLE_MESSAGE, "a constant message is a stable Sentry title");
  assert.equal(e.assetUrl, url, "the sample rides beside the message, never inside it");
  // Own property, not just a declaration: `App.tsx` reads it off the caught error with a
  // cast (`(e as { assetUrl?: string | null }).assetUrl`) to reach `extra.assetUrl`, and a
  // field that survived only in the .d.ts would make that read undefined in production.
  assert.ok(Object.hasOwn(e, "assetUrl"));
  assert.ok(!e.message.includes(url), "the URL in the title is what made DEMOS-15 name one sample");
  assert.equal(e.cause, cause);
});

test("the failure latches: no third fetch, and no second error object", async () => {
  let calls = 0;
  const { load } = createBoundedLoader(
    async () => {
      calls += 1;
      throw new TypeError("Failed to fetch dynamically imported module");
    },
    (c) => new CompilerUnavailableError(c),
  );

  const first = await load().catch((e) => e);
  assert.equal(calls, 2);
  const second = await load().catch((e) => e);
  assert.equal(calls, 2, "a latched compiler must not re-fetch 3 MB per keystroke");
  assert.equal(second, first, "the same error, so Sentry's dedupe sees one fault");
});

test("rearm buys one more pair of attempts, and nothing else does", async () => {
  // Wired to *Restart preview*: a visitor whose network came back must not have to
  // reload and lose unsaved edits, while no code path retries on its own.
  let calls = 0;
  let offline = true;
  // Composed exactly as `loadBabel` is — the memo underneath is what makes a recovered
  // load stay cached, and the bound on top is what stops the retrying.
  const { load, rearm } = createBoundedLoader(
    createLazyLoader(async () => {
      calls += 1;
      if (offline) throw new TypeError("Failed to fetch dynamically imported module");
      return "babel";
    }),
    (c) => new CompilerUnavailableError(c),
  );

  await assert.rejects(load(), (e) => isCompilerUnavailable(e));
  assert.equal(calls, 2);
  await assert.rejects(load(), (e) => isCompilerUnavailable(e));
  assert.equal(calls, 2, "still latched without an explicit rearm");

  offline = false;
  rearm();
  assert.equal(await load(), "babel", "the visitor's retry gets a real attempt");
  assert.equal(calls, 3);
  assert.equal(await load(), "babel", "and the loader is healthy again afterwards");
  assert.equal(calls, 3, "the successful chunk is cached, as it always was");
});

test("a rearm against a rotated chunk fails again, immediately terminal", async () => {
  let calls = 0;
  const { load, rearm } = createBoundedLoader(
    async () => {
      calls += 1;
      throw new TypeError("Failed to fetch dynamically imported module");
    },
    (c) => new CompilerUnavailableError(c),
  );

  await assert.rejects(load(), (e) => isCompilerUnavailable(e));
  rearm();
  await assert.rejects(load(), (e) => isCompilerUnavailable(e));
  assert.equal(calls, 4, "two attempts per explicit request, and no more");
  await assert.rejects(load(), (e) => isCompilerUnavailable(e));
  assert.equal(calls, 4, "which is what leaves a reload as the only cure for a rotated asset");
});

test("isCompilerUnavailable is a marker check, not a message sniff", () => {
  assert.equal(isCompilerUnavailable(new CompilerUnavailableError(new Error("x"))), true);
  assert.equal(isCompilerUnavailable(new SyntaxError("Unexpected token")), false);
  assert.equal(
    isCompilerUnavailable(new Error("the in-browser compiler could not be loaded")),
    false,
    "a mid-edit parse error must keep pushUpdate's silence even if it says the words",
  );
  assert.equal(isCompilerUnavailable(null), false);
  assert.equal(isCompilerUnavailable("compiler"), false);
});

test("a CompilerUnavailableError with an unparseable cause still reports", () => {
  const e = new CompilerUnavailableError(new Error("Load failed"));
  assert.equal(e.assetUrl, null, "Safari's wording carries no URL; the report must not depend on one");
  assert.equal(e.message, COMPILER_UNAVAILABLE_MESSAGE);
});
