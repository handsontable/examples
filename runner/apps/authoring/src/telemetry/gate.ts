// Contract §10 "Local telemetry gate in the browser" + ADR §E.4's last bullet.
//
// Decides whether Faro runs at all, independent of whether it is wired up:
//
//   - production: reuse `resolveReporting(...).enabled` verbatim (the SAME
//     production/automation gate Sentry uses — the task text is explicit:
//     "production via resolveReporting unchanged, still closed under
//     automation"). Faro needs no DSN of its own, but production always ships
//     one, and reusing the flag keeps Faro and Sentry turning on and off
//     together rather than drifting into two gates that can disagree.
//   - local: `VITE_TELEMETRY_LOCAL=1` at BUILD time AND the RUNTIME host is
//     `localhost`/`127.0.0.1`. Deliberately checks neither `import.meta.env.DEV`
//     nor `navigator.webdriver` (contract §10): Playwright serves a production
//     `vite preview` build under automation, so a DEV/webdriver check would
//     make the e2e spec (`e2e/telemetry-faro.spec.ts`) unable to ever see Faro
//     fire against its own built dist.
//
// Import-free, same reason and same constraint as `reportingGate.ts` /
// `eventGate.ts`: `pipeline/faro-config.test.mjs` imports this directly under
// `--experimental-strip-types`, which cannot resolve a sibling `./x.js`
// specifier or an npm package. Do not let it grow imports.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export interface TelemetryGateInputs {
  /** `resolveReporting({ dsn, hostname, webdriver }).enabled` — computed by the
   *  caller (`reportingGate.ts`), not recomputed here, so this module stays
   *  free of the `dsn`/`webdriver` inputs that decision needs. */
  productionReportingEnabled: boolean;
  /** `import.meta.env.VITE_TELEMETRY_LOCAL` — a BUILD-time flag. Only the exact
   *  string `"1"` opens the local path; absent, empty or any other value keeps
   *  it closed. */
  localFlag?: string;
  /** `window.location.hostname`, or undefined outside a browser. */
  hostname?: string;
}

/** Whether Faro initialises at all. `true` on either leg — production is not
 *  "more true" than local; a caller that needs to know which one fired reads
 *  `telemetryEnvironment` instead. */
export function resolveTelemetryEnabled({
  productionReportingEnabled,
  localFlag,
  hostname,
}: TelemetryGateInputs): boolean {
  if (productionReportingEnabled) return true;
  return localFlag === "1" && hostname !== undefined && LOCAL_HOSTS.has(hostname);
}

/** `deployment.environment.name` (contract §3/§10): `"production"` when the
 *  production leg opened the gate, `"local"` when only the local leg did.
 *  Meaningless (and never read) when `resolveTelemetryEnabled` returned
 *  `false` — the caller does not initialise Faro at all in that case. */
export function telemetryEnvironment(productionReportingEnabled: boolean): "production" | "local" {
  return productionReportingEnabled ? "production" : "local";
}
