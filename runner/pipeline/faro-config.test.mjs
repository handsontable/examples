import test from "node:test";
import assert from "node:assert/strict";
import { resolveTelemetryEnabled, telemetryEnvironment } from "../apps/authoring/src/telemetry/gate.ts";

// T06, contract §10 "Local telemetry gate in the browser" + ADR §E.4's last
// bullet. `telemetry/gate.ts` is import-free for the same reason as
// `reportingGate.ts` (its own header explains the constraint) — this file
// imports it directly under `--experimental-strip-types`.
//
// The actual Faro wiring (`telemetry/faro.ts`) cannot be tested here: it pulls
// in `@grafana/faro-web-sdk` and reads `import.meta.env`, so `node --test`
// cannot import it, the same constraint `sentry.ts` documents for itself. This
// file pins the DECISION `faro.ts` delegates to `gate.ts`, which is the whole
// of what "the local path exactly as contract §10 defines it" and "production
// via resolveReporting unchanged" mean as testable claims.

test("production leg: reuses resolveReporting's decision verbatim, regardless of the local flag/host", () => {
  assert.equal(
    resolveTelemetryEnabled({ productionReportingEnabled: true, localFlag: undefined, hostname: undefined }),
    true,
  );
  // Even a WRONG local flag/host does not close a production-open gate — the
  // production leg is unconditional once `productionReportingEnabled` is true.
  assert.equal(
    resolveTelemetryEnabled({ productionReportingEnabled: true, localFlag: "0", hostname: "evil.test" }),
    true,
  );
});

test("production closed + no local flag: closed", () => {
  assert.equal(
    resolveTelemetryEnabled({ productionReportingEnabled: false, localFlag: undefined, hostname: "localhost" }),
    false,
  );
});

test("local leg: opens on localhost with the exact flag '1'", () => {
  assert.equal(
    resolveTelemetryEnabled({ productionReportingEnabled: false, localFlag: "1", hostname: "localhost" }),
    true,
  );
});

test("local leg: opens on 127.0.0.1 too", () => {
  assert.equal(
    resolveTelemetryEnabled({ productionReportingEnabled: false, localFlag: "1", hostname: "127.0.0.1" }),
    true,
  );
});

test("local leg: any other flag value stays closed (only the literal '1' opens it)", () => {
  for (const localFlag of [undefined, "", "true", "0", "yes"]) {
    assert.equal(
      resolveTelemetryEnabled({ productionReportingEnabled: false, localFlag, hostname: "localhost" }),
      false,
      `localFlag=${JSON.stringify(localFlag)}`,
    );
  }
});

test("local leg: any other host stays closed, even with the flag set", () => {
  for (const hostname of [undefined, "demos.handsontable.com", "example.com", "0.0.0.0"]) {
    assert.equal(
      resolveTelemetryEnabled({ productionReportingEnabled: false, localFlag: "1", hostname }),
      false,
      `hostname=${JSON.stringify(hostname)}`,
    );
  }
});

// The contract's explicit negative: neither `import.meta.env.DEV` nor
// `navigator.webdriver` are inputs to this function at all — Playwright serves
// a production `vite preview` build under automation (contract §10), so a
// DEV/webdriver check would make `e2e/telemetry-faro.spec.ts` unable to ever
// see Faro fire against its own built dist. This is a structural guard: the
// function's parameter list itself has no such field, so there is nothing a
// future edit could "helpfully" wire up without changing the signature this
// test imports.
test("the gate takes no DEV/webdriver input — only productionReportingEnabled, localFlag, hostname", () => {
  assert.deepEqual(resolveTelemetryEnabled.length, 1); // one destructured object param
});

test("telemetryEnvironment: production when the production leg opened the gate", () => {
  assert.equal(telemetryEnvironment(true), "production");
});

test("telemetryEnvironment: local otherwise", () => {
  assert.equal(telemetryEnvironment(false), "local");
});
