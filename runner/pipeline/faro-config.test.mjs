import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTelemetryEnabled, telemetryEnvironment } from "../apps/authoring/src/telemetry/gate.ts";

// Contract §10 "Local telemetry gate in the browser" + ADR §E.4's last
// bullet. `telemetry/gate.ts` is import-free for the same reason as
// `reportingGate.ts` — this file imports it directly under
// `--experimental-strip-types`.
//
// The actual Faro wiring (`telemetry/faro.ts`) cannot be tested here: it
// pulls in `@grafana/faro-web-sdk` and reads `import.meta.env`, so
// `node --test` cannot import it. This file pins the decision `faro.ts`
// delegates to `gate.ts`, and the settings it takes from `faroConfig.ts`.

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

// ---- batching and delivery (`telemetry/faroConfig.ts`) ---------------------------

const { FARO_BATCHING, FARO_RETRY, FARO_BUFFER_SIZE } = await import("../apps/authoring/src/telemetry/faroConfig.ts");
// The 429's Retry-After is the limiter window (`o11y-routes.test.mjs` pins the two equal).
const wranglerText = readFileSync(fileURLToPath(new URL("../workers/o11y/wrangler.jsonc", import.meta.url)), "utf8");
const RATE_LIMIT_PERIOD_SECONDS = Number(/"ratelimits"[\s\S]*?"period":\s*(\d+)/.exec(wranglerText)?.[1]);

test("batching: one flush per 5 s, 50 items per batch", () => {
  assert.deepEqual(FARO_BATCHING, { enabled: true, sendTimeout: 5_000, itemLimit: 50 });
});

test("retry: a 429's Retry-After (the limiter window) plus Faro's 20 % jitter fits under maxBackoffMs", () => {
  assert.equal(FARO_RETRY.maxBackoffMs, 75_000);
  assert.equal(RATE_LIMIT_PERIOD_SECONDS, 60);
  // Faro drops a batch whose Retry-After exceeds maxBackoffMs, and caps the jittered wait at it.
  assert.ok(FARO_RETRY.maxBackoffMs >= RATE_LIMIT_PERIOD_SECONDS * 1000 * 1.2);
  assert.ok(FARO_RETRY.maxAttempts >= 2, "a 429'd batch gets at least one retry");
});

test("the delivery queue stays bounded", () => {
  assert.equal(FARO_BUFFER_SIZE, 30);
});

test("faro.ts hands these settings to initializeFaro and its FetchTransport", () => {
  const source = readFileSync(fileURLToPath(new URL("../apps/authoring/src/telemetry/faro.ts", import.meta.url)), "utf8");
  assert.match(source, /batching:\s*\{\s*\.\.\.FARO_BATCHING\s*\}/);
  assert.match(source, /new FetchTransport\(\{[^}]*bufferSize:\s*FARO_BUFFER_SIZE[^}]*retry:\s*\{\s*\.\.\.FARO_RETRY\s*\}/);
  // With `transports` given, a top-level `url` would make Faro log a config error.
  assert.doesNotMatch(source, /initializeFaro\(\{\s*url:/);
});
