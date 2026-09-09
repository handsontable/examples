// Retry policy, buckets, and tag/extra shaping for `fetchVersions` /
// `fetchDocsJson` (DEV-2859, Sentry DEMOS-2X / DEMOS-7D).
//
// The central claim under test: retry is the discriminator between a
// visitor's own network dropping mid-request (a blip, recovers on the second
// attempt) and a real host dip (fails at both attempts). `!res.ok` is
// deliberately never retried — the "exactly one call" tests below are the
// retry-storm guard for that.
//
// Every ambient dependency (fetch, the clock, `navigator.onLine`, the retry
// delay/timeout) is injected, so this drives every branch without a DOM and
// without real timers.

import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithDiagnostics,
  readFetchDiagnostics,
  elapsedBucket,
  apiBaseOrigin,
  diagnosticTags,
  diagnosticExtras,
} from "../apps/authoring/src/fetchDiagnostics.ts";

function fakeClock(step = 10) {
  let t = 0;
  return () => { t += step; return t; };
}

const noSleep = () => Promise.resolve();

function okResponse(extra = {}) {
  return { ok: true, status: 200, ...extra };
}

function notOkResponse(status) {
  return { ok: false, status };
}

// --- retry policy ------------------------------------------------------

test("success on the first attempt: exactly one fetch call, outcome ok", async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; return okResponse(); };
  const { res, diagnostics } = await fetchWithDiagnostics("https://x/test", undefined, {
    fetchFn, now: fakeClock(), isOnline: () => true, sleep: noSleep,
  });
  assert.equal(calls, 1);
  assert.equal(res.ok, true);
  assert.equal(diagnostics.attempts, 1);
  assert.equal(diagnostics.outcome, "ok");
});

test("a transport failure then a 200: two calls, outcome ok, the good response is returned", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return okResponse({ marker: "second" });
  };
  const { res, diagnostics } = await fetchWithDiagnostics("https://x/test", undefined, {
    fetchFn, now: fakeClock(), isOnline: () => true, sleep: noSleep,
  });
  assert.equal(calls, 2);
  assert.equal(res.marker, "second");
  assert.equal(diagnostics.attempts, 2);
  assert.equal(diagnostics.outcome, "ok");
});

test("both attempts fail (transport): throws with attempts 2, diagnostics attached", async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; throw new TypeError("Failed to fetch"); };
  await assert.rejects(
    fetchWithDiagnostics("https://x/test", undefined, {
      fetchFn, now: fakeClock(), isOnline: () => true, sleep: noSleep,
    }),
    (error) => {
      assert.equal(calls, 2);
      const diag = readFetchDiagnostics(error);
      assert.equal(diag.attempts, 2);
      assert.equal(diag.outcome, "transport");
      // name/message untouched, so isOpaqueNetworkFailure (fetchFailure.ts)
      // still classifies it — the whole point of a non-enumerable property.
      assert.equal(error.name, "TypeError");
      assert.equal(error.message, "Failed to fetch");
      return true;
    },
  );
});

test("!res.ok (our host answering, e.g. 503): retry-storm guard — exactly one fetch call", async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; return notOkResponse(503); };
  const { res, diagnostics } = await fetchWithDiagnostics("https://x/test", undefined, {
    fetchFn, now: fakeClock(), isOnline: () => true, sleep: noSleep,
  });
  // This function has no opinion on HTTP status: a 503 is a completed request,
  // so outcome is "ok" and the caller (catalog.ts) decides what a non-2xx
  // status means. What matters here is the call count: retrying an outage
  // would amplify it.
  assert.equal(calls, 1);
  assert.equal(res.ok, false);
  assert.equal(diagnostics.attempts, 1);
});

test("aborting the first attempt: outcome timeout, one call, no raw AbortError escapes undiagnosed", async () => {
  let calls = 0;
  const fetchFn = async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  };
  await assert.rejects(
    fetchWithDiagnostics("https://x/test", undefined, {
      fetchFn, now: fakeClock(), isOnline: () => true, sleep: noSleep, timeoutMs: 1,
    }),
    (error) => {
      assert.equal(calls, 1); // a timeout never retries
      const diag = readFetchDiagnostics(error);
      // The caller (App.tsx) is instructed to branch on diagnostics.outcome,
      // never on re-classifying the error itself — this is what makes that
      // possible: the outcome is readable without inspecting error.name.
      assert.equal(diag.outcome, "timeout");
      assert.equal(diag.attempts, 1);
      return true;
    },
  );
});

test("onlineAtStart is read once, at the start of the call", async () => {
  const fetchFn = async () => okResponse();
  const { diagnostics } = await fetchWithDiagnostics("https://x/test", undefined, {
    fetchFn, now: fakeClock(), isOnline: () => false, sleep: noSleep,
  });
  assert.equal(diagnostics.onlineAtStart, false);
});

// --- apiBaseOrigin -----------------------------------------------------

test("apiBaseOrigin: the committed localhost fallback reads as localhost", () => {
  assert.equal(apiBaseOrigin("http://localhost:8787", "https://demos.handsontable.com"), "localhost");
});

test("apiBaseOrigin: same host as the page is same", () => {
  assert.equal(
    apiBaseOrigin("https://demos.handsontable.com/api", "https://demos.handsontable.com"),
    "same",
  );
});

test("apiBaseOrigin: a different host is cross", () => {
  assert.equal(apiBaseOrigin("https://api.example.com", "https://demos.handsontable.com"), "cross");
});

// --- elapsedBucket -------------------------------------------------------

test("elapsedBucket: every boundary is pinned from both sides", () => {
  const pairs = [
    [0, "<100ms"],
    [99, "<100ms"],
    [100, "<500ms"],
    [499, "<500ms"],
    [500, "<1s"],
    [999, "<1s"],
    [1000, "<3s"],
    [2999, "<3s"],
    [3000, "<5s"],
    [4999, "<5s"],
    [5000, ">=5s"],
    [50_000, ">=5s"],
  ];
  for (const [ms, expected] of pairs) {
    assert.equal(elapsedBucket(ms), expected, `elapsedBucket(${ms})`);
  }
});

// --- diagnosticTags / diagnosticExtras -----------------------------------

test("diagnosticTags: prefixes tag names from context, versions-fetch", () => {
  const tags = diagnosticTags({
    context: "versions-fetch",
    attempts: 2,
    outcome: "transport",
    onlineAtStart: true,
    elapsedMs: 6000,
    apiBaseOrigin: "localhost",
  });
  assert.equal(tags.context, "versions-fetch");
  assert.equal(tags.versions_fetch_attempts, "2");
  assert.equal(tags.versions_fetch_outcome, "transport");
  assert.equal(tags.versions_fetch_elapsed_bucket, ">=5s");
  assert.equal(tags.versions_fetch_online, "true");
  assert.equal(tags.api_base_origin, "localhost");
});

test("diagnosticTags: prefixes tag names from context, docs-fetch (DEMOS-7D)", () => {
  const tags = diagnosticTags({
    context: "docs-fetch",
    attempts: 1,
    outcome: "ok",
    onlineAtStart: undefined,
    elapsedMs: 50,
  });
  assert.equal(tags.docs_fetch_attempts, "1");
  assert.equal(tags.docs_fetch_outcome, "ok");
  assert.equal("docs_fetch_online" in tags, false); // omitted when unknown
});

test("diagnosticExtras: host-class only, never a raw URL", () => {
  const extras = diagnosticExtras({
    context: "versions-fetch",
    attempts: 2,
    outcome: "transport",
    onlineAtStart: true,
    elapsedMs: 1234,
    apiBaseOrigin: "same",
  });
  assert.equal(extras.elapsedMs, "1234");
  assert.match(extras.attemptSummary, /2 attempts, transport/);
  assert.equal(extras.apiBaseClass, "same");
  for (const value of Object.values(extras)) {
    assert.equal(String(value).includes("http"), false);
    assert.equal(String(value).includes("?"), false);
  }
});

test("the attached fetchDiagnostics property is non-enumerable", async () => {
  // Load-bearing, and previously only inferred from `name`/`message` staying
  // intact. If this property ever became enumerable it would surface in
  // `JSON.stringify(error)` and in any spread of the error, changing what
  // downstream reporting sees — and an enumerable own property is the kind of
  // thing a refactor flips without noticing. Pinned directly.
  let caught;
  try {
    await fetchWithDiagnostics("https://example.test/api/versions", {
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
      now: (() => { let t = 0; return () => (t += 10); })(),
      sleep: () => Promise.resolve(),
      onLine: () => true,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected the exhausted retry to throw");
  const descriptor = Object.getOwnPropertyDescriptor(caught, "fetchDiagnostics");
  assert.ok(descriptor, "fetchDiagnostics should be an own property");
  assert.equal(descriptor.enumerable, false);
  assert.equal("fetchDiagnostics" in JSON.parse(JSON.stringify({ ...caught })), false);
  // And the accessor still reads it, so non-enumerable does not mean unreachable.
  assert.ok(readFetchDiagnostics(caught));
});
