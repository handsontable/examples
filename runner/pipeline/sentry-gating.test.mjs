import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_HOST, resolveReporting } from "../apps/authoring/src/reportingGate.ts";
import {
  apiSentryDsn,
  apiSentryEnvironment,
  rehomeBudgetAlert,
} from "../workers/api/src/sentry-gate.ts";

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
