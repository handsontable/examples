// Observability contract §4 (Analytics Engine layout) and §5 (metric registry).
//
// `pipeline/telemetry-contract.test.mjs` parses both tables out of
// `docs/observability-contract.md` and compares them against `AE_COLUMNS` and
// `METRICS` below, slot for slot and outcome for outcome — edit the doc and this
// file together (README "Contract" rule); editing either alone fails the test.

import {
  DEVICE_CLASSES,
  ENVIRONMENTS,
  HT_MAJORS,
  SERVICE_NAMES,
  SURFACES,
  TIERS,
  type CommonResourceAttrs,
  type HotAttrs,
} from "./attrs.js";

// ---- §4: Analytics Engine layout (`runner_events`) -----------------------------

/**
 * Column name → Analytics Engine slot (`blobN` / `doubleN`), plus `metric` →
 * `index1`. The single source SQL builders (local ClickHouse shim and any
 * Analytics Engine SQL) read to translate a human column name to its positional
 * slot (T00-D2: the local shim's table uses these same slot names as its column
 * names, so `SELECT blob8 AS outcome` style SQL is the only translation layer,
 * never a second name mapping).
 */
export const AE_COLUMNS: Readonly<Record<string, string>> = {
  metric: "index1",
  service_name: "blob1",
  service_version: "blob2",
  environment: "blob3",
  surface: "blob4",
  tier: "blob5",
  framework: "blob6",
  ht_major: "blob7",
  outcome: "blob8",
  reason: "blob9",
  route_class: "blob10",
  fingerprint: "blob11",
  demo_id: "blob12",
  model: "blob13",
  provider: "blob14",
  device: "blob15",
  bucket: "blob16",
  kind: "blob17",
  ref: "blob18",
  area: "blob19",
  count: "double1",
  duration_ms: "double2",
  value: "double3",
  usd: "double4",
  tokens_in: "double5",
  tokens_out: "double6",
  bytes: "double7",
  cap: "double8",
};

/** Highest blob/double slot number any column occupies — `blob20` and
 *  `double9`–`double20` are reserved and unassigned (§4), but a point is always
 *  written at this fixed width so a stored row's shape never depends on which
 *  columns a particular metric happened to fill (T00-D2). */
const BLOB_SLOT_COUNT = 20;
const DOUBLE_SLOT_COUNT = 20;

// ---- §5: metric registry -------------------------------------------------------

interface MetricDefData {
  /** Free text from the "Emitted by" column — informational, not slot-checked. */
  readonly emittedBy: string;
  /** Attribute/column names this metric's "Blobs used" cell lists, beyond the
   *  three universal resource attrs (`service_name`, `service_version`,
   *  `environment`), which every metric carries. */
  readonly blobs: readonly string[];
  /** Column names this metric's "Doubles" cell lists. */
  readonly doubles: readonly string[];
  /** Attribute name → its closed set of allowed values, only for attributes the
   *  doc actually constrains (`outcome`, `reason`, or — for
   *  `preview.runtime_error` — a fixed `surface`). An attribute in `blobs` with
   *  no entry here is open: any string is accepted. */
  readonly values?: Readonly<Record<string, readonly string[]>>;
}

const EXAMPLE_ACTION_BLOBS = ["kind", "ref", "area", "framework", "ht_major", "bucket"] as const;
const EXAMPLE_ACTION: MetricDefData = {
  emittedBy: "browser (ADR-0042)",
  blobs: EXAMPLE_ACTION_BLOBS,
  doubles: ["count"],
};

const SERVE_DEF: MetricDefData = {
  emittedBy: "API worker",
  blobs: ["outcome", "demo_id"],
  doubles: ["count", "bytes"],
  values: { outcome: ["2xx", "304", "4xx", "5xx"] },
};

/** `session.start`'s outcome set — `session.start_ms` reuses it verbatim (the
 *  doc says so as "outcomes as `session.start`"; the contract test resolves that
 *  alias by parsing the referenced row, and the two arrays are compared for
 *  equality, not for a shared reference). */
const SESSION_START_OUTCOMES = [
  "ready",
  "at_capacity",
  "container_starting",
  "boot_timeout",
  "budget_denied",
  "error",
] as const;

const REGISTRY_DATA = {
  "preview.ready_ms": {
    emittedBy: "browser",
    blobs: ["surface", "tier", "framework", "ht_major", "outcome", "bucket"],
    doubles: ["duration_ms"],
    values: { outcome: ["ready", "error", "timeout", "abandoned"] },
  },
  "sandpack.compile_ms": {
    emittedBy: "browser",
    blobs: ["tier", "framework", "ht_major", "outcome"],
    doubles: ["duration_ms"],
    values: { outcome: ["ok", "error"] },
  },
  "sandpack.compile_error": {
    emittedBy: "browser",
    blobs: ["framework", "ht_major", "fingerprint"],
    doubles: ["count"],
  },
  "sandpack.bundler_unreachable": {
    emittedBy: "browser",
    blobs: ["ht_major"],
    doubles: ["count", "duration_ms"],
  },
  "preview.runtime_error": {
    emittedBy: "browser",
    blobs: ["surface", "tier", "framework", "ht_major", "fingerprint", "reason"],
    doubles: ["count"],
    values: {
      surface: ["demo-runtime"],
      reason: ["uncaught", "console", "network", "stderr"],
    },
  },
  "version.switch": {
    emittedBy: "browser",
    // "ht_major (to)" / "reason (from)" — descriptive, not enumerable: `ht_major`
    // is the version switched *to*, `reason` carries the framework/version
    // switched *from* as a free-form label.
    blobs: ["framework", "ht_major", "reason", "bucket"],
    doubles: ["count"],
  },
  "bucket.resolve_ms": {
    emittedBy: "browser",
    blobs: ["bucket", "outcome"],
    doubles: ["duration_ms"],
    values: { outcome: ["ok", "error"] },
  },
  "session.start_ms": {
    emittedBy: "browser",
    blobs: ["framework", "ht_major", "outcome", "reason"],
    doubles: ["duration_ms"],
    values: { outcome: SESSION_START_OUTCOMES, reason: ["cold", "warm"] },
  },
  "hmr.roundtrip_ms": {
    emittedBy: "browser",
    blobs: ["framework", "ht_major"],
    doubles: ["duration_ms"],
  },
  web_vital: {
    emittedBy: "browser, beacon",
    blobs: ["surface", "framework", "ht_major", "reason", "device", "demo_id"],
    doubles: ["value"],
    values: { reason: ["LCP", "INP", "CLS", "TTFB"] },
  },
  "error.uncaught": {
    emittedBy: "browser, beacon",
    blobs: ["surface", "fingerprint", "demo_id"],
    doubles: ["count"],
  },
  "error.handled": {
    emittedBy: "browser, API worker",
    blobs: ["surface", "route_class", "fingerprint"],
    doubles: ["count"],
  },
  "example.open": {
    emittedBy: "browser (ADR-0042)",
    blobs: [...EXAMPLE_ACTION_BLOBS, "reason"],
    doubles: ["count"],
    // "reason (`entry`)" in the Blobs cell adds `entry` (the first open) to the
    // reason values the Outcomes/reason cell lists for later navigations.
    values: { reason: ["entry", "deep-link", "picker", "switch", "version-switch", "fork"] },
  },
  "example.engaged": EXAMPLE_ACTION,
  "example.forked": EXAMPLE_ACTION,
  "example.saved": EXAMPLE_ACTION,
  "example.shared": EXAMPLE_ACTION,
  "example.downloaded": EXAMPLE_ACTION,
  "api.request": {
    emittedBy: "API worker",
    blobs: ["route_class", "outcome"],
    doubles: ["count", "duration_ms"],
    values: { outcome: ["2xx", "3xx", "4xx", "5xx"] },
  },
  "session.start": {
    emittedBy: "API worker",
    blobs: ["framework", "ht_major", "outcome"],
    doubles: ["count", "duration_ms"],
    values: { outcome: SESSION_START_OUTCOMES },
  },
  "session.end": {
    emittedBy: "API worker",
    blobs: ["framework", "reason"],
    doubles: ["count", "value"],
    values: { reason: ["pagehide", "sleep_after", "teardown_failed", "budget_closed"] },
  },
  "container.boot_ms": {
    emittedBy: "API worker",
    blobs: ["framework", "outcome", "reason"],
    doubles: ["duration_ms"],
    values: { outcome: ["ready", "window_exceeded", "error"], reason: ["cold", "warm"] },
  },
  "pool.gauge": {
    emittedBy: "API worker */5",
    blobs: ["reason"],
    doubles: ["value", "cap"],
    values: { reason: ["live", "builder"] },
  },
  "budget.gauge": {
    emittedBy: "API worker */5",
    // "reason (tier)" — descriptive, not enumerable: reason carries the budget
    // tier name.
    blobs: ["reason"],
    doubles: ["value", "usd"],
  },
  "snapshot.build": {
    emittedBy: "API worker",
    blobs: ["framework", "outcome", "reason"],
    doubles: ["count", "duration_ms", "bytes"],
    values: { outcome: ["ok", "failed"], reason: ["inline", "detached"] },
  },
  "serve.share": SERVE_DEF,
  "serve.d": SERVE_DEF,
  "serve.embed": SERVE_DEF,
  "chat.answer": {
    emittedBy: "API worker",
    blobs: ["model", "outcome"],
    doubles: ["count", "duration_ms", "usd", "tokens_in", "tokens_out"],
    values: { outcome: ["answered", "denied", "error"] },
  },
  "chat.edit": {
    emittedBy: "API worker",
    blobs: ["outcome"],
    doubles: ["count"],
    values: { outcome: ["proposed", "applied", "undone"] },
  },
  "theme.ai": {
    emittedBy: "API worker",
    blobs: ["model", "outcome"],
    doubles: ["count", "duration_ms", "usd"],
    values: { outcome: ["answered", "denied", "error"] },
  },
  "import.url": {
    emittedBy: "API worker",
    blobs: ["provider", "outcome", "reason"],
    doubles: ["count", "duration_ms"],
    values: { outcome: ["ok", "refused", "error"] },
  },
  "payload.boot": {
    emittedBy: "API worker",
    blobs: ["framework", "outcome"],
    doubles: ["count"],
    values: { outcome: ["ok", "error"] },
  },
  "reconcile.run": {
    emittedBy: "API worker cron",
    blobs: ["outcome"],
    doubles: ["count", "duration_ms", "usd"],
    values: { outcome: ["ok", "skipped", "error"] },
  },
  "o11y.ingest": {
    emittedBy: "o11y worker",
    blobs: ["reason", "outcome"],
    doubles: ["count", "bytes"],
    // "reason = gate" — the reason is the gate name (open, see §B.5), not a
    // fixed set.
    values: { outcome: ["accepted", "dropped", "duplicate"] },
  },
  "o11y.drain": {
    emittedBy: "o11y worker",
    blobs: ["reason", "outcome"],
    doubles: ["count", "duration_ms", "bytes", "value"],
    values: { outcome: ["ok", "partial", "error"], reason: ["backlog", "visit", "reopen"] },
  },
  "o11y.wake": {
    emittedBy: "o11y worker",
    blobs: ["reason", "outcome"],
    doubles: ["count", "duration_ms"],
    values: { reason: ["backlog", "visit"], outcome: ["clean", "unclean"] },
  },
  "o11y.backlog": {
    emittedBy: "o11y worker cron",
    blobs: [],
    doubles: ["value", "bytes"],
  },
  "o11y.alert": {
    emittedBy: "o11y worker cron",
    // "reason (rule id)" — descriptive, not enumerable: reason carries the
    // alert rule's id.
    blobs: ["reason", "outcome"],
    doubles: ["count"],
    values: { outcome: ["fired", "resolved"] },
  },
} as const satisfies Record<string, MetricDefData>;

export type MetricName = keyof typeof REGISTRY_DATA;

export interface MetricDef extends MetricDefData {
  readonly name: MetricName;
}

export const METRICS: Readonly<Record<MetricName, MetricDef>> = Object.fromEntries(
  Object.entries(REGISTRY_DATA).map(([name, def]) => [name, { name: name as MetricName, ...def }]),
) as Record<MetricName, MetricDef>;

export const METRIC_NAMES: readonly MetricName[] = Object.keys(REGISTRY_DATA) as MetricName[];

// ---- Points ----------------------------------------------------------------

/** The doubles a metric's "Doubles" column can name — a subset is present on
 *  any one call, matching the metric's own `doubles` list. */
export interface MetricValues {
  count?: number;
  duration_ms?: number;
  value?: number;
  usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  bytes?: number;
  cap?: number;
}

export interface AePoint {
  /** `index1` — the sampling key every query filters on directly. */
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/** Closed sets `toAePoint` enforces regardless of which metric is being
 *  written — on top of the per-metric `values` constraints in `METRICS`. */
const CLOSED_ATTRIBUTE_SETS: Readonly<Record<string, readonly string[]>> = {
  service_name: SERVICE_NAMES,
  environment: ENVIRONMENTS,
  surface: SURFACES,
  tier: TIERS,
  ht_major: HT_MAJORS,
  device: DEVICE_CLASSES,
};

function slotOffset(slot: string): number {
  const m = /^(?:blob|double)(\d+)$/.exec(slot);
  if (!m || m[1] === undefined) throw new Error(`toAePoint: not a slot name: "${slot}"`);
  return Number(m[1]) - 1;
}

/**
 * Build one Analytics Engine data point (§4) for `metric`, from its §5-declared
 * doubles and attributes. Positional and dense: every call returns a
 * `BLOB_SLOT_COUNT`/`DOUBLE_SLOT_COUNT`-wide array, unused slots `""` / `0`, so a
 * stored row's shape never depends on which columns happened to be filled
 * (T00-D2).
 *
 * Throws — never silently drops — when `metric` is unknown, when `attrs.outcome`
 * or `attrs.reason` is set for a metric whose §5 row does not list that column,
 * or when a value is set outside the column's closed set (per-metric `values`,
 * or a repo-wide closed set like `surface`/`tier`/`ht_major`). This is a producer
 * contract, enforced on our own call sites, not a scrub of untrusted input — see
 * `scrub.ts` for that.
 */
export function toAePoint(
  metric: MetricName,
  values: MetricValues,
  attrs: HotAttrs & CommonResourceAttrs,
): AePoint {
  const def = METRICS[metric];
  if (!def) throw new Error(`toAePoint: unknown metric ${JSON.stringify(metric)}`);

  const blobs = new Array<string>(BLOB_SLOT_COUNT).fill("");
  const doubles = new Array<number>(DOUBLE_SLOT_COUNT).fill(0);
  const attrBag = attrs as unknown as Record<string, string | undefined>;
  const valueBag = values as Record<string, number | undefined>;

  const writeBlob = (column: string, value: string) => {
    const slot = AE_COLUMNS[column];
    if (!slot) throw new Error(`toAePoint: no AE column for "${column}"`);
    blobs[slotOffset(slot)] = value;
  };
  const checkAllowed = (column: string, value: string) => {
    const allowed = def.values?.[column] ?? CLOSED_ATTRIBUTE_SETS[column];
    if (allowed && !allowed.includes(value)) {
      throw new Error(
        `toAePoint: "${value}" is not an allowed "${column}" for metric "${metric}" ` +
          `(allowed: ${allowed.join(", ")})`,
      );
    }
  };

  // blob1–3: universal resource attrs, on every record (T00-D2).
  for (const column of ["service_name", "service_version", "environment"] as const) {
    const value = attrBag[column];
    if (value === undefined) continue;
    checkAllowed(column, value);
    writeBlob(column, value);
  }

  // `outcome`/`reason` set for a metric that does not list them: a caller bug,
  // not silently dropped input.
  for (const column of ["outcome", "reason"] as const) {
    if (attrBag[column] !== undefined && !def.blobs.includes(column)) {
      throw new Error(`toAePoint: metric "${metric}" has no "${column}" slot`);
    }
  }

  for (const column of def.blobs) {
    const value = attrBag[column];
    if (value === undefined) continue;
    checkAllowed(column, value);
    writeBlob(column, value);
  }

  for (const column of def.doubles) {
    const value = valueBag[column];
    if (value === undefined) continue;
    const slot = AE_COLUMNS[column];
    if (!slot) throw new Error(`toAePoint: no AE column for "${column}"`);
    doubles[slotOffset(slot)] = value;
  }

  return { indexes: [metric], blobs, doubles };
}
