// Observability contract §3 — attribute keys, allowed values, Loki labels.
// Pure data/types, no DOM, no Cloudflare imports: imported by the authoring
// app, both Workers and `pipeline/` tests. `pipeline/telemetry-contract.test.mjs`
// parses `docs/observability-contract.md` §3 and fails if this file
// disagrees with it — edit both together.

/** The four deployables that stamp `service.name` on every record they emit. */
export const SERVICE_NAMES = [
  "demos-authoring",
  "demos-api",
  "demos-o11y",
  "demos-embed",
] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export const ENVIRONMENTS = ["production", "local"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const SURFACES = [
  "authoring",
  "share",
  "embed",
  "d",
  "api",
  "demo-runtime",
  "o11y",
] as const;
export type Surface = (typeof SURFACES)[number];

export const TIERS = ["1", "2", "static", "none"] as const;
export type Tier = (typeof TIERS)[number];

/** `hot.ht_major` — every supported major, plus the `next` channel and `none`
 *  (a signal with no HT version attached). Closed set: the contract's `…` range
 *  is a shorthand for these five numbers. */
export const HT_MAJORS = ["15", "16", "17", "18", "19", "next", "none"] as const;
export type HtMajor = (typeof HT_MAJORS)[number];

/** `hot.framework` on a stored record: the `config/frameworks.json` keys (the
 *  docs-example frameworks are among them) plus `none`. Ingest replaces any
 *  other value with {@link OTHER_ATTR_VALUE}; `pipeline/telemetry-contract.test.mjs`
 *  fails when this list and `frameworks.json` disagree. */
export const KNOWN_FRAMEWORKS = [
  "blank",
  "blank-ts",
  "blank-react",
  "example1",
  "javascript",
  "typescript",
  "react",
  "react-js",
  "ant-design",
  "mui",
  "base-web",
  "fluent-ui",
  "vue",
  "angular",
  "next.js",
  "next-shadcn.js",
  "astro",
  "nuxt",
  "remix",
  "none",
] as const;

export type Framework = string;

/** `hot.outcome` allowed values are per metric (§5, `metrics.ts`); a record no
 *  metric describes (a log, an exception, a plain event) carries only these. */
export const RECORD_OUTCOMES = ["none"] as const;

export type Outcome = string;

/** What ingest stores for a `hot.framework`/`hot.outcome` outside its known set:
 *  both are Loki labels, and each distinct value is a stream (Loki's default
 *  limit is 5000 per tenant). */
export const OTHER_ATTR_VALUE = "other";

/** Bounds a client-sent `fw` before it reaches the known-set mapping, so a
 *  multi-kilobyte value is refused outright (ADR §B.4). */
export const OPEN_ATTR_VALUE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function isValidOpenAttrValue(value: string): boolean {
  return OPEN_ATTR_VALUE_PATTERN.test(value);
}

// ---- Resource attribute keys (OTLP), §3 ---------------------------------------

export const ATTR_SERVICE_NAME = "service.name";
export const ATTR_SERVICE_VERSION = "service.version";
export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";
export const ATTR_HOT_SURFACE = "hot.surface";
export const ATTR_HOT_TIER = "hot.tier";
export const ATTR_HOT_FRAMEWORK = "hot.framework";
export const ATTR_HOT_HT_MAJOR = "hot.ht_major";
export const ATTR_HOT_OUTCOME = "hot.outcome";

/** Structured metadata only (§3): never a Loki label, never an Analytics Engine
 *  index. `hot.kind` is the Faro item kind (`exception`, `log`, `event`,
 *  `measurement`). */
export const ATTR_HOT_DEMO_ID = "hot.demo_id";
export const ATTR_SESSION_ID = "session.id";
export const ATTR_CF_RAY = "cf.ray";
export const ATTR_HOT_KIND = "hot.kind";

/** §3's closed value set for `hot.kind` — the Faro item kind. `trace` is
 *  excluded: no trace is ever exported (ADR §C.4). */
export const HOT_KINDS = ["exception", "log", "event", "measurement"] as const;

export const STRUCTURED_METADATA_KEYS = [
  ATTR_HOT_DEMO_ID,
  ATTR_SESSION_ID,
  ATTR_CF_RAY,
  ATTR_HOT_KIND,
] as const;

/** §3 "Diagnostic tags": flat, non-dotted metadata on a handled-error or
 *  diagnostic-event report (§6), hoisted into `attributes` by
 *  `convert.ts#hoistAttributes`'s `STRUCTURED_KEY_SET` — never a Loki label.
 *  Each entry is a boolean flag, an opaque platform id, an enum/bucketed
 *  value, or a call site's own name — never user or request content. */
export const DIAGNOSTIC_TAG_KEYS = [
  "handled",
  "context",
  "sentry_event_id",
  "versions_fetch_attempts",
  "versions_fetch_outcome",
  "versions_fetch_elapsed_bucket",
  "versions_fetch_online",
  "api_base_origin",
  "net_effective_type",
] as const;

/** The AE-only browser attribute channel (ADR-0042): `HotAttrs` fields
 *  `toAePoint` accepts but §3 gives no resource/structured-metadata slot to.
 *  Read only by `browser-attrs.ts#readAeOnlyAttrs` from the raw wire body,
 *  BEFORE `scrubTelemetry` runs; `convert.ts#hoistAttributes` does not
 *  recognise these keys, so they never reach `resourceAttributes`/`attributes`. */
export const ATTR_HOT_BUCKET = "hot.bucket";
export const ATTR_HOT_REASON = "hot.reason";
export const ATTR_HOT_FINGERPRINT = "hot.fingerprint";
export const ATTR_HOT_METRIC_KIND = "hot.metric_kind";
export const ATTR_HOT_REF = "hot.ref";
export const ATTR_HOT_AREA = "hot.area";

export const AE_ONLY_ATTRIBUTE_KEYS = [
  ATTR_HOT_BUCKET,
  ATTR_HOT_REASON,
  ATTR_HOT_FINGERPRINT,
  ATTR_HOT_METRIC_KIND,
  ATTR_HOT_REF,
  ATTR_HOT_AREA,
] as const;

/** One row per §3 resource attribute: OTLP key, Loki label (`undefined` =
 *  none), and Analytics Engine blob slot (`AE_COLUMNS` in `metrics.ts` is
 *  the single source `sink.ts`/`inbox.ts` read). */
export interface ResourceAttrDef {
  key: string;
  lokiLabel?: string;
  aeSlot: string;
}

export const RESOURCE_ATTRS: readonly ResourceAttrDef[] = [
  { key: ATTR_SERVICE_NAME, lokiLabel: "service_name", aeSlot: "blob1" },
  { key: ATTR_SERVICE_VERSION, aeSlot: "blob2" },
  {
    key: ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
    lokiLabel: "deployment_environment_name",
    aeSlot: "blob3",
  },
  { key: ATTR_HOT_SURFACE, lokiLabel: "hot_surface", aeSlot: "blob4" },
  { key: ATTR_HOT_TIER, lokiLabel: "hot_tier", aeSlot: "blob5" },
  { key: ATTR_HOT_FRAMEWORK, lokiLabel: "hot_framework", aeSlot: "blob6" },
  { key: ATTR_HOT_HT_MAJOR, lokiLabel: "hot_ht_major", aeSlot: "blob7" },
  { key: ATTR_HOT_OUTCOME, lokiLabel: "hot_outcome", aeSlot: "blob8" },
];

/** The Loki label list `otlp_config` promotes resource attributes to (ADR §B.4). */
export const LOKI_LABELS: readonly string[] = RESOURCE_ATTRS.filter((a) => a.lokiLabel).map(
  (a) => a.lokiLabel as string,
);

/** §3's forbidden list enforced as an allowlist, not a denylist: every
 *  forbidden attribute (`url.full`, geo, an IP, a user-agent string) is
 *  simply absent, so a future one is dropped without a code change. */
export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  ...RESOURCE_ATTRS.map((a) => a.key),
  ...STRUCTURED_METADATA_KEYS,
  ...DIAGNOSTIC_TAG_KEYS,
  ...AE_ONLY_ATTRIBUTE_KEYS,
]);

/** §4 blob15 `device`. Only `classify.ts#deviceOf` and the `web_vital` metric use
 *  it, but the set is shared so a bogus device class fails the same way an
 *  unlisted outcome does. */
export const DEVICE_CLASSES = ["desktop", "mobile", "tablet"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/**
 * §6's `HotAttrs` — the attribute bag every `Telemetry.metric`/`.event`/`.error`
 * call carries. Every field is optional: a given metric only reads the columns
 * its §5 registry row lists (`metrics.ts#toAePoint`); passing more is ignored,
 * passing `outcome`/`reason` for a metric that lists neither is a thrown error.
 */
export interface HotAttrs {
  surface?: Surface;
  tier?: Tier;
  framework?: Framework;
  ht_major?: HtMajor;
  outcome?: Outcome;
  reason?: string;
  route_class?: string;
  fingerprint?: string;
  demo_id?: string;
  model?: string;
  provider?: string;
  device?: DeviceClass;
  bucket?: string;
  kind?: string;
  ref?: string;
  area?: string;
}

/** The three resource attrs stamped on every record (blob1–3), never part of a
 *  metric's own §5 "Blobs used" column because they are universal, not
 *  metric-specific. */
export interface CommonResourceAttrs {
  service_name: ServiceName;
  service_version: string;
  environment: Environment;
}
