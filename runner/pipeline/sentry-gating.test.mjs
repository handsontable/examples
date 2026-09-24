import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCTION_HOST, resolveReporting } from "../apps/authoring/src/reportingGate.ts";
import {
  apiSentryDsn,
  apiSentryEnvironment,
  rehomeBudgetAlert,
} from "../workers/api/src/sentry-gate.ts";
import {
  applyFaroTee,
  isEdgelessForeignSessionStart,
  isForeignUnhandled,
  isOfficeScannerRejection,
  isUnhandledNoise,
} from "../apps/authoring/src/eventGate.ts";
import { resolveSentryScope, reportsDiagnosticToSentry } from "../apps/authoring/src/sentryScope.ts";
import { safeInit } from "../apps/authoring/src/bootGuard.ts";

// DEV-2540. Three classes of traffic reached the production Sentry project that had
// no business being there — local dev sessions, a Playwright run pointed at
// production, and the nightly spend alerts — plus one structural defect in the
// Worker gate that fails OPEN. Each branch below is one of those, pinned so the
// gates cannot rot back.
//
// Neither `sentry.ts` nor `index.ts` can be tested directly (one reads
// `import.meta.env` and imports @sentry/react, the other is a Worker entrypoint),
// which is exactly why both decisions live in import-free modules. Do not try to
// import those two here.

const DSN = "https://public@o0.ingest.sentry.io/1";

test("the production host still reports, under the literal the Sentry rules key on", () => {
  assert.deepEqual(resolveReporting({ dsn: DSN, hostname: PRODUCTION_HOST, webdriver: false }), {
    enabled: true,
    environment: "authoring-production",
  });
});

test("an automation harness does not report (DEMOS-P)", () => {
  // A Playwright suite run with E2E_BASE_URL=https://demos.handsontable.com filed
  // three real issues against production. `navigator.webdriver` is the discriminator
  // — matching the stub's response body would pin a literal that is in no commit.
  const decision = resolveReporting({ dsn: DSN, hostname: PRODUCTION_HOST, webdriver: true });
  assert.equal(decision.enabled, false);
});

test("a browser that does not expose navigator.webdriver still reports", () => {
  // Guards against writing the conjunct as `!webdriver`, which would silently
  // disable reporting for every such browser.
  const decision = resolveReporting({ dsn: DSN, hostname: PRODUCTION_HOST, webdriver: undefined });
  assert.equal(decision.enabled, true);
});

test("any other host is off, and labels itself authoring-local", () => {
  // One case, both observed dev shapes: the vite-dev sessions at :5174/:5175 AND
  // the production-MODE build served at :4173 that produced DEMOS-2. The hostname,
  // not the build mode, is the discriminator — `import.meta.env.MODE` would have
  // read "production" for the second one and changed nothing.
  assert.deepEqual(resolveReporting({ dsn: DSN, hostname: "localhost" }), {
    enabled: false,
    environment: "authoring-local",
  });
});

test("no window (SSR / node) is off and does not throw", () => {
  assert.deepEqual(resolveReporting({ dsn: DSN, hostname: undefined }), {
    enabled: false,
    environment: "authoring-local",
  });
});

test("environment is computed independently of enabled", () => {
  // The point of the split: whoever next patches the gate open to verify the wiring
  // off-host gets events that label themselves, instead of 15 more indistinguishable
  // `authoring-production` issues. So a missing DSN must not drag the environment
  // away from the production literal on the production host.
  for (const dsn of [undefined, ""]) {
    const decision = resolveReporting({ dsn, hostname: PRODUCTION_HOST, webdriver: false });
    assert.equal(decision.enabled, false);
    assert.equal(decision.environment, "authoring-production");
  }
});

test("the host check is equality, not a suffix test", () => {
  const decision = resolveReporting({
    dsn: DSN,
    hostname: `${PRODUCTION_HOST}.evil.test`,
    webdriver: false,
  });
  assert.equal(decision.enabled, false);
  assert.equal(decision.environment, "authoring-local");
});

const DEPLOYED = {
  PREVIEW_HOST: "demos.handsontable.com",
  SENTRY_ENVIRONMENT: "api-production",
  ERROR_REPORTING_DSN: DSN,
};

test("the deployed Worker reports as api-production", () => {
  assert.equal(apiSentryDsn(DEPLOYED), DSN);
  assert.equal(apiSentryEnvironment(DEPLOYED), "api-production");
});

test("the committed wrangler.jsonc vars alone are never enough", () => {
  // The regression test for the fail-open bug. This env is exactly the state of a
  // developer who skipped the `.dev.vars` setup step: PREVIEW_HOST and the DSN both
  // come straight from committed config, so the old single-signal gate opened and
  // `wrangler dev` filed local runs into the production project.
  //
  // `apiSentryDsn` reads `env.SENTRY_ENVIRONMENT` itself rather than calling
  // `apiSentryEnvironment`, deliberately: the tempting future edit to the latter is
  // a default (`|| "api-production"`) so every event carries a label even on a bare
  // `wrangler deploy`, and through a shared code path that would reopen this gate
  // for every local run. That coupling is not observable from outside the two
  // functions, so it is guarded by the comments in sentry-gate.ts — this assertion
  // is what would go red if the gate were reconnected to a defaulted labeller.
  const { SENTRY_ENVIRONMENT: _omitted, ...noDeployVar } = DEPLOYED;
  assert.equal(apiSentryDsn(noDeployVar), undefined);
  assert.equal(apiSentryEnvironment(noDeployVar), undefined);
});

test("an empty --var does not open the gate either", () => {
  // `wrangler deploy --var SENTRY_ENVIRONMENT:` yields "", which is why the check
  // is truthiness rather than `!== undefined`.
  assert.equal(apiSentryDsn({ ...DEPLOYED, SENTRY_ENVIRONMENT: "" }), undefined);
});

test("the original PREVIEW_HOST conjunct still holds", () => {
  assert.equal(apiSentryDsn({ ...DEPLOYED, PREVIEW_HOST: "localhost:8787" }), undefined);
});

test("budget alerts are re-homed to their own environment", () => {
  const event = { tags: { context: "budget-alert", threshold: "40" } };
  const out = rehomeBudgetAlert(event);
  assert.equal(out, event, "beforeSend must return the event, not null — nothing is dropped");
  assert.equal(out.environment, "budget-alerts");
});

test("a failure of the alert job itself is NOT re-homed", () => {
  // reconcile.ts's catch files under `budget-alert-check`. That is a genuine Worker
  // fault and must keep its routing — hence strict equality on the tag, never a
  // prefix test.
  const out = rehomeBudgetAlert({ tags: { context: "budget-alert-check" } });
  assert.equal(out.environment, undefined);
});

test("ordinary events pass through untouched", () => {
  for (const event of [{}, { tags: {} }, { tags: { context: "tier2-session-start" } }]) {
    const out = rehomeBudgetAlert(event);
    assert.equal(out, event);
    assert.equal(out.environment, undefined);
  }
});

// ── Fix round D-I2: isUnhandledNoise / isForeignUnhandled, moved from sentry.ts ──
//
// Moved into `eventGate.ts` (previously private to `sentry.ts`, untestable) so
// `telemetry/faro.ts`'s `beforeSend` can apply the SAME predicates Sentry's own
// `beforeSend` does — contract §6's "shared noise gates" requirement. Before this
// fix, only Sentry ever ran them.

test("isUnhandledNoise: a ResizeObserver loop warning, unhandled, is noise", () => {
  const event = {
    exception: { values: [{ type: "Error", value: "ResizeObserver loop completed with undelivered notifications.", mechanism: { handled: false } }] },
  };
  assert.equal(isUnhandledNoise(event), true);
});

test("isUnhandledNoise: a navigation-abort Failed to fetch, unhandled, is noise", () => {
  const event = {
    exception: { values: [{ type: "TypeError", value: "Failed to fetch", mechanism: { handled: false } }] },
  };
  assert.equal(isUnhandledNoise(event), true);
});

test("isUnhandledNoise: the SAME message, but handled (an explicit report), is NOT noise", () => {
  const event = {
    exception: { values: [{ type: "TypeError", value: "Failed to fetch", mechanism: { handled: true } }] },
  };
  assert.equal(isUnhandledNoise(event), false, "an explicit reportError('Failed to fetch') must still be reported");
});

test("isUnhandledNoise: an unrelated unhandled error is NOT noise", () => {
  const event = {
    exception: { values: [{ type: "TypeError", value: "x is not a function", mechanism: { handled: false } }] },
  };
  assert.equal(isUnhandledNoise(event), false);
});

test("isForeignUnhandled: an unhandled error whose stack is entirely outside this origin is dropped", () => {
  const event = {
    exception: {
      values: [
        {
          type: "TypeError",
          value: "boom",
          mechanism: { handled: false },
          stacktrace: { frames: [{ filename: "https://sandpack-bundler.codesandbox.io/bundle.js" }] },
        },
      ],
    },
  };
  assert.equal(isForeignUnhandled(event, "https://demos.handsontable.com"), true);
});

test("isForeignUnhandled: an unhandled error with an own-origin frame is NOT dropped", () => {
  const event = {
    exception: {
      values: [
        {
          type: "TypeError",
          value: "boom",
          mechanism: { handled: false },
          stacktrace: { frames: [{ filename: "https://demos.handsontable.com/assets/index.js" }] },
        },
      ],
    },
  };
  assert.equal(isForeignUnhandled(event, "https://demos.handsontable.com"), false);
});

test("isForeignUnhandled: a HANDLED report through a foreign frame is NOT dropped", () => {
  const event = {
    exception: {
      values: [
        {
          type: "TypeError",
          value: "boom",
          mechanism: { handled: true },
          stacktrace: { frames: [{ filename: "https://sandpack-bundler.codesandbox.io/bundle.js" }] },
        },
      ],
    },
  };
  assert.equal(isForeignUnhandled(event, "https://demos.handsontable.com"), false);
});

test("isUnhandledNoise / isForeignUnhandled: no exception values -> false, not thrown on", () => {
  assert.equal(isUnhandledNoise({}), false);
  assert.equal(isForeignUnhandled({ exception: { values: [] } }, "https://x"), false);
});

// ── DEV-2858. beforeSend suppression gates for two NOT-OURS populations ─────────
//
// `isOfficeScannerRejection` (DEMOS-5F) and `isEdgelessForeignSessionStart`
// (DEMOS-9) live in `eventGate.ts`, import-free for the same reason as
// `sentry-gate.ts` above. P = dropped (positive match), N = reported (must survive).

// ── DEMOS-5F: Office/Outlook safelink scanner ────────────────────────────────────

test("P1: the scanner's injected rejection is dropped", () => {
  // A failure to drop this means the gate's regex or its handled-conjunct broke.
  const event = {
    exception: {
      values: [
        {
          type: "UnhandledRejection",
          value:
            "Non-Error promise rejection captured with value: Object Not Found Matching Id:12, MethodName:update, ParamCount:4",
          mechanism: { handled: false },
        },
      ],
    },
  };
  assert.equal(isOfficeScannerRejection(event), true);
});

test("P2: a different Id/MethodName/ParamCount is still dropped", () => {
  // Fails if anyone hardcodes Id:12 / MethodName:update instead of matching the
  // discriminating prose around the varying fields.
  const event = {
    exception: {
      values: [
        {
          type: "UnhandledRejection",
          value:
            "Non-Error promise rejection captured with value: Object Not Found Matching Id:9, MethodName:getInstance, ParamCount:2",
          mechanism: { handled: false },
        },
      ],
    },
  };
  assert.equal(isOfficeScannerRejection(event), true);
});

test("N1: the same text reported on purpose (handled: true) survives", () => {
  // An explicit captureException quoting this text must not be silently dropped —
  // guards the mechanism.handled === false conjunct, not just the regex.
  const event = {
    exception: {
      values: [
        {
          type: "Error",
          value: "Object Not Found Matching Id:12, MethodName:update, ParamCount:4",
          mechanism: { handled: true },
        },
      ],
    },
  };
  assert.equal(isOfficeScannerRejection(event), false);
});

test("N2: an unrelated 'not found' unhandled error survives", () => {
  // Guards against a loose /not found/i standing in for the real, discriminating
  // phrase.
  const event = {
    exception: {
      values: [
        {
          type: "Error",
          value: "Configuration object not found for column 3",
          mechanism: { handled: false },
        },
      ],
    },
  };
  assert.equal(isOfficeScannerRejection(event), false);
});

test("N3: an event with no exception values does not throw and is not dropped", () => {
  // Guards an unguarded event.exception.values deref.
  assert.equal(isOfficeScannerRejection({ exception: { values: [] } }), false);
  assert.equal(isOfficeScannerRejection({}), false);
});

// ── DEMOS-9: edgeless-foreign session-start facet ────────────────────────────────
//
// Tag shapes mirror the ones App.tsx:292-305 actually sets.

test("P1: foreign origin with no cf_ray is dropped", () => {
  const event = {
    tags: {
      context: "tier2-session-start",
      session_status: "504",
      session_response_origin: "foreign",
      session_response_type: "basic",
      session_elapsed_bucket: "<1s",
      framework: "angular",
    },
  };
  assert.equal(isEdgelessForeignSessionStart(event), true);
});

test("P2: a different session_status is still dropped", () => {
  // Fails if someone adds a status conjunct — the tier turns on where the response
  // came from, not on the status (pipeline/session-start-failure.test.mjs:464).
  const event = {
    tags: {
      context: "tier2-session-start",
      session_status: "503",
      session_response_origin: "foreign",
      session_response_type: "basic",
      session_elapsed_bucket: "<1s",
      framework: "angular",
    },
  };
  assert.equal(isEdgelessForeignSessionStart(event), true);
});

test("N1 (highest value in this change): a foreign-shaped event WITH a cf_ray is reported", () => {
  // Unreachable today — sessionDiagnostics.ts's responseOrigin only returns
  // "foreign" when there is no ray. This is a spec guard on an input the taxonomy
  // does not currently produce, kept because the !cf_ray conjunct is narrowing
  // (can only suppress less), not widening (see eventGate.ts's comment). Fails the
  // moment the gate is collapsed to an origin-only check.
  const event = {
    tags: {
      context: "tier2-session-start",
      session_status: "504",
      session_response_origin: "foreign",
      session_response_type: "basic",
      session_elapsed_bucket: "<1s",
      framework: "angular",
      cf_ray: "9a1b2c3d4e5f6789-WAW",
    },
  };
  assert.equal(isEdgelessForeignSessionStart(event), false);
});

test("N2: the real capacity signal — cloudflare origin with a ray — is reported", () => {
  // Fails if the gate is collapsed to a ray-only check instead of requiring the
  // foreign origin too.
  const event = {
    tags: {
      context: "tier2-session-start",
      session_status: "504",
      session_response_origin: "cloudflare",
      cf_ray: "9a1b2c3d4e5f6789-WAW",
    },
  };
  assert.equal(isEdgelessForeignSessionStart(event), false);
});

test("N3: an 'unreadable' origin (cross-origin dev) is reported", () => {
  // headersReadable is called load-bearing at session-start-failure.test.mjs:432 —
  // absence of a ray proves nothing when headers cannot be read at all.
  const event = {
    tags: {
      context: "tier2-session-start",
      session_response_origin: "unreadable",
    },
  };
  assert.equal(isEdgelessForeignSessionStart(event), false);
});

test("N4: a 'headerless' origin is reported", () => {
  // One taxonomy value is suppressed by this gate, not three.
  const event = {
    tags: {
      context: "tier2-session-start",
      session_response_origin: "headerless",
    },
  };
  assert.equal(isEdgelessForeignSessionStart(event), false);
});

test("N5: an untagged pre-instrumentation event is reported", () => {
  // The ~88 events predating DEV-2559's diagnostics tags. Guards a
  // !== "cloudflare" inversion — an absent session_response_origin must not be
  // treated as evidence of "foreign".
  const event = { tags: { context: "tier2-session-start", session_status: "504" } };
  assert.equal(isEdgelessForeignSessionStart(event), false);
});

test("N6: a foreign-shaped event under a different context is reported", () => {
  // Guards the context scoping conjunct — a future reuse of
  // session_response_origin outside tier2-session-start must not be silently
  // silenced.
  const event = { tags: { context: "tier2-container-boot", session_response_origin: "foreign" } };
  assert.equal(isEdgelessForeignSessionStart(event), false);
});

test("N7: an event with no tags at all does not throw and is not dropped", () => {
  assert.equal(isEdgelessForeignSessionStart({}), false);
  assert.equal(isEdgelessForeignSessionStart({ tags: {} }), false);
});

// ── T06, contract §11 / ADR §E.3: VITE_SENTRY_SCOPE ──────────────────────────────
//
// `sentryScope.ts` is import-free for the same reason as `reportingGate.ts` — see
// its own header. The truth table: `"full"` is the default for every input other
// than the exact string `"uncaught"`, and `reportsDiagnosticToSentry` only ever
// narrows `reportingEnabled`, never widens it.

test("resolveSentryScope: only the literal 'uncaught' opens the narrow scope", () => {
  assert.equal(resolveSentryScope("uncaught"), "uncaught");
});

test("resolveSentryScope: absent, empty, or any other string stays 'full'", () => {
  for (const raw of [undefined, "", "Uncaught", "UNCAUGHT", "full", "off", "uncaught "]) {
    assert.equal(resolveSentryScope(raw), "full", `raw=${JSON.stringify(raw)}`);
  }
});

test("reportsDiagnosticToSentry: full scope + reporting enabled -> true", () => {
  assert.equal(reportsDiagnosticToSentry(true, "full"), true);
});

test("reportsDiagnosticToSentry: uncaught scope closes it even though reporting is enabled", () => {
  // The launch-plan flip (ADR §E.3): once this ships, a handled diagnostic no
  // longer reaches Sentry at all, on the production host, with reporting on.
  assert.equal(reportsDiagnosticToSentry(true, "uncaught"), false);
});

test("reportsDiagnosticToSentry: never widens a closed reportingEnabled gate", () => {
  // The regression this guards: a scope switch must not become a second way to
  // turn Sentry on when the production/automation gate (reportingGate.ts) is
  // already closed — full scope on a closed gate still reports nothing.
  assert.equal(reportsDiagnosticToSentry(false, "full"), false);
  assert.equal(reportsDiagnosticToSentry(false, "uncaught"), false);
});

// ── Minor triage item 5: unguarded browser telemetry ─────────────────────────────
//
// `main.tsx`'s `initTelemetry()` call and `sentry.ts`'s ADR §E.2 tee were both
// unguarded — a synchronous throw in either used to propagate out (blanking the
// app before `createRoot`, or making the SDK drop the whole Sentry event). Both
// fixes are thin call sites around the two guarded functions below; these tests
// exercise the actual guarding logic. Reverting either `try`/`catch` in
// `bootGuard.ts#safeInit` / `eventGate.ts#applyFaroTee` back to an unguarded call
// makes the matching "still renders" / "still returns the event" test below throw
// instead of passing.

test("safeInit: a throwing init is swallowed and reported, never propagates (main.tsx still renders)", () => {
  let reported;
  assert.doesNotThrow(() => {
    safeInit(
      () => {
        throw new Error("Faro client construction failed");
      },
      (err) => {
        reported = err;
      },
    );
  });
  assert.ok(reported instanceof Error);
  assert.equal(reported.message, "Faro client construction failed");
});

test("safeInit: a non-throwing init runs normally and onError is never called", () => {
  let ran = false;
  let reported;
  safeInit(
    () => {
      ran = true;
    },
    (err) => {
      reported = err;
    },
  );
  assert.equal(ran, true);
  assert.equal(reported, undefined);
});

test("applyFaroTee: sets the page_load_id tag and pushes a sentry.event, returns the event", () => {
  const event = { event_id: "abc123", tags: { existing: "x" } };
  const telemetry = {
    pageLoadId: () => "plid-1",
    event(name, attrs) {
      this.calls = this.calls ?? [];
      this.calls.push({ name, attrs });
    },
  };
  const out = applyFaroTee(event, telemetry);
  assert.equal(out, event, "must return the same event, never null/undefined");
  assert.equal(out.tags.page_load_id, "plid-1");
  assert.equal(out.tags.existing, "x", "existing tags must be preserved");
  assert.deepEqual(telemetry.calls, [{ name: "sentry.event", attrs: { sentry_event_id: "abc123" } }]);
});

test("applyFaroTee: a throwing telemetry.pageLoadId() is swallowed — the event still ships", () => {
  const event = { event_id: "abc123", tags: {} };
  const telemetry = {
    pageLoadId: () => {
      throw new Error("Faro client not ready");
    },
    event: () => {
      throw new Error("must not be reached");
    },
  };
  let out;
  assert.doesNotThrow(() => {
    out = applyFaroTee(event, telemetry);
  });
  assert.equal(out, event, "the event must still be returned, not dropped");
});

test("applyFaroTee: a throwing telemetry.event() is swallowed — the event still ships with its tag set", () => {
  const event = { event_id: "abc123", tags: {} };
  const telemetry = {
    pageLoadId: () => "plid-2",
    event: () => {
      throw new Error("Faro push failed");
    },
  };
  let out;
  assert.doesNotThrow(() => {
    out = applyFaroTee(event, telemetry);
  });
  assert.equal(out, event);
  assert.equal(out.tags.page_load_id, "plid-2", "the tag set before the throw is kept, not rolled back");
});

// Advisor follow-up on minor triage item 5: the tests above prove
// `safeInit`/`applyFaroTee` THEMSELVES never throw — they do NOT prove the
// real call sites still call them. `main.tsx`/`sentry.ts` cannot be
// imported here (they pull in React/`@sentry/react`/`import.meta.env`, the
// same constraint this file's own header note gives for `sentry.ts` and
// `index.ts`), so the wiring is pinned structurally instead, the same
// pattern `pipeline/mcp-create.test.mjs`'s "the update route calls
// isMcpCreated()" test uses. Reverting either call site (back to a bare
// `initTelemetry();`, or the inline try/catch instead of
// `applyFaroTee(event, telemetry)`) makes the matching assertion fail even
// though every test above it stays green.
test("main.tsx calls initTelemetry() through safeInit(), not bare", () => {
  const root = join(import.meta.dirname, "..");
  const source = readFileSync(join(root, "apps/authoring/src/main.tsx"), "utf8");
  assert.match(source, /safeInit\(\s*initTelemetry\s*,/, "main.tsx must call initTelemetry() through safeInit()");
  assert.doesNotMatch(
    source,
    /^\s*initTelemetry\(\);\s*$/m,
    "a bare, unguarded initTelemetry(); call on its own line would defeat the guard entirely",
  );
});

test("sentry.ts's beforeSend returns applyFaroTee(event, telemetry), not an inline tee", () => {
  const root = join(import.meta.dirname, "..");
  const source = readFileSync(join(root, "apps/authoring/src/sentry.ts"), "utf8");
  assert.match(
    source,
    /return applyFaroTee\(event, telemetry\);/,
    "beforeSend must return applyFaroTee(event, telemetry), the guarded tee",
  );
  assert.doesNotMatch(
    source,
    /telemetry\.pageLoadId\(\)/,
    "sentry.ts itself must not call telemetry.pageLoadId() directly — that belongs entirely to eventGate.ts#applyFaroTee now",
  );
});
