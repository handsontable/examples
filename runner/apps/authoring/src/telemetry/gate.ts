// Contract §10 + ADR §E.4's last bullet: Faro runs when production reuses
// `resolveReporting(...).enabled` (same gate Sentry uses), or when
// `VITE_TELEMETRY_LOCAL=1` (BUILD time) AND a localhost/127.0.0.1 RUNTIME
// host — never DEV/webdriver, since Playwright serves a production build
// under automation. Import-free like `reportingGate.ts`/`eventGate.ts`.

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

/** `deployment.environment.name` (contract §3/§10): `"production"` when
 *  the production leg opened the gate, `"local"` when only local did. */
export function telemetryEnvironment(productionReportingEnabled: boolean): "production" | "local" {
  return productionReportingEnabled ? "production" : "local";
}
