// Whether the browser reports to Sentry, and under which `environment` (DEV-2540).
//
// Split out of `sentry.ts` so the decision itself is testable: that module imports
// `@sentry/react` and reads `import.meta.env`, neither of which node resolves, so
// nothing in it can be covered by a test. This one is dependency-free on purpose —
// `pipeline/sentry-gating.test.mjs` imports it with `--experimental-strip-types`,
// which cannot resolve sibling `./x.js` specifiers. Same constraint, and same
// reason, as `guideTracks.ts`. Do not let it grow imports.
//
// `enabled` and `environment` are computed INDEPENDENTLY, deliberately. There is no
// supported way to exercise the Sentry wiring off-host, so the next person who needs
// to verify it will patch `enabled` open locally, exactly as happened on
// 2026-07-27/28 — 15 localhost events landed in the production project labelled
// `authoring-production` and were indistinguishable from real traffic. With the two
// outputs separate, a patched-open gate still labels its events `authoring-local`
// and they can be filtered out in one click.

/**
 * The deployed host. Reporting is enabled ONLY here.
 *
 * `.env.production` is committed and is therefore loaded by every production-mode
 * build, including `ci.yml`'s "Build authoring" step — whose output Playwright
 * then serves at http://localhost:4173. Without this gate every PR run, and every
 * local `vite preview`, would file events against the production project. Gating
 * on the runtime hostname (rather than on a second env var or a CI secret) makes
 * that structurally impossible.
 *
 * The API worker gates on `PREVIEW_HOST` for the same reason — see
 * workers/api/src/sentry-gate.ts.
 */
export const PRODUCTION_HOST = "demos.handsontable.com";

/** What the production browser events are filed under. Existing Sentry alert
 *  rules and saved searches key on this literal, so it must not drift. */
const PRODUCTION_ENVIRONMENT = "authoring-production";

/** Anything served from any other host. Never sent while the gate is closed; it
 *  exists so that a gate patched open locally is still self-labelling. */
const LOCAL_ENVIRONMENT = "authoring-local";

export interface ReportingInputs {
  /** `import.meta.env.VITE_SENTRY_DSN`. Absent or empty -> reporting off. */
  dsn?: string;
  /** `window.location.hostname`, or undefined outside a browser. */
  hostname?: string;
  /** `navigator.webdriver` — `true` under every automation harness. */
  webdriver?: boolean;
}

export interface ReportingDecision {
  enabled: boolean;
  environment: string;
}

/**
 * Three conjuncts, each closing a traffic class that reached the production
 * project:
 *
 * - `dsn` — nothing to send to without one.
 * - `hostname` — the original production gate. Strict equality, never a suffix
 *   test: `demos.handsontable.com.evil.test` must not pass.
 * - `webdriver` — new in DEV-2540. `navigator.webdriver` is `true` under any
 *   automation harness, which is how a Playwright suite pointed at the production
 *   host stops filing (DEMOS-P: 3 events, release `ddf044c0`, Chrome 149 on
 *   Windows, `context: tier2-session-start`, from an ad-hoc local run with
 *   `E2E_BASE_URL=https://demos.handsontable.com`). Compared against `true`
 *   rather than written `!webdriver`: a browser that does not expose the property
 *   at all reports `undefined`, and must keep reporting.
 *
 * The gate is the right place for all three. `beforeSend` would build events and
 * throw them away, and editing it risks the foreign-frame narrowing and the
 * `surface: demo-runtime` re-homing that live there; not initialising the SDK at
 * all costs nothing and touches neither.
 *
 * `environment` is derived from the hostname and NOT from `import.meta.env.MODE`.
 * DEMOS-2 was a production-MODE build served at localhost:4173, so a mode-derived
 * value would still have read `authoring-production` — a no-op for the exact case
 * that motivated this.
 *
 * There is deliberately no force-enable escape hatch: a bypass flag would enlarge
 * the surface this change exists to shrink. Off-host verification points
 * `VITE_SENTRY_DSN` at a separate project's DSN — see docs/run-and-deploy.md.
 */
export function resolveReporting({ dsn, hostname, webdriver }: ReportingInputs): ReportingDecision {
  const onProductionHost = hostname === PRODUCTION_HOST;
  return {
    enabled: Boolean(dsn) && onProductionHost && webdriver !== true,
    environment: onProductionHost ? PRODUCTION_ENVIRONMENT : LOCAL_ENVIRONMENT,
  };
}
