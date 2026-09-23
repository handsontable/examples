// Observability contract §3 — attribute keys, allowed values, Loki labels.
//
// Pure data/types, no DOM, no Cloudflare imports: this module is imported by the
// authoring app, both Workers and `pipeline/` tests alike (see the package header
// in index.ts). `pipeline/telemetry-contract.test.mjs` parses
// `docs/observability-contract.md` §3 and fails if this file disagrees with it —
// treat the doc as the source of truth and edit both together (README "Contract"
// rule).

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

/**
 * `hot.framework` is an open set by contract ("a key of `config/frameworks.json`,
 * a docs-example framework, or `none`") — new frameworks land without a change
 * here. Kept as `string`, never validated against a closed list.
 */
export type Framework = string;

/** `hot.outcome` has no single closed set: allowed values are per metric (§5),
 *  see `metrics.ts`. */
export type Outcome = string;

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

/** §3's closed value set for `hot.kind` — "the Faro item kind." `event` is
 *  Faro's `EventEvent` kind (unrelated to this repo's own open `EventName`,
 *  §6); `trace` is deliberately excluded — no trace is ever exported (ADR
 *  §C.4), so a record claiming that kind is malformed, not a fourth
 *  legitimate value. */
export const HOT_KINDS = ["exception", "log", "event", "measurement"] as const;
export type HotKind = (typeof HOT_KINDS)[number];

export const STRUCTURED_METADATA_KEYS = [
  ATTR_HOT_DEMO_ID,
  ATTR_SESSION_ID,
  ATTR_CF_RAY,
  ATTR_HOT_KIND,
] as const;
export type StructuredMetadataKey = (typeof STRUCTURED_METADATA_KEYS)[number];

/**
 * §3 "Diagnostic tags" — flat, non-dotted metadata on a handled-error or
 * diagnostic-event report only (§6). Distinct from `STRUCTURED_METADATA_KEYS`:
 * these are not hoisted to a Loki resource attribute or a structured-metadata
 * field by `convert.ts#hoistAttributes` (that function only recognises
 * `RESOURCE_ATTR_KEYS` and `STRUCTURED_KEY_SET`) — this allowlist only
 * decides whether the browser-side (and re-run, server-side) scrub keeps them
 * at all; what ingest does with a kept-but-not-hoisted attribute is the
 * ingest route's own decision.
 *
 * Each entry is a boolean flag, an opaque platform id, an enum-like/bucketed
 * value, or a reporting call site's own name — never user or request content
 * (controller ruling, T06 fix round D1):
 *
 * - `handled` — `"true"` marks a §6 `error.handled` report (set by the
 *   browser facade's `Telemetry.error()`, contract §6).
 * - `context` — the reporting call site's own name (e.g. `tier1-compiler-asset`,
 *   `versions-fetch`), the same string passed to `fingerprint()`'s `context`
 *   argument (§7). An open set of short, developer-chosen literals, not free
 *   text.
 * - `sentry_event_id` — the ADR §E.2 tee: Sentry's own opaque event id,
 *   pushed as a Faro event alongside the page-load id going the other way.
 * - `versions_fetch_attempts`, `versions_fetch_outcome`,
 *   `versions_fetch_elapsed_bucket`, `versions_fetch_online` — the
 *   `versions-fetch` diagnostic's own tags (`fetchDiagnostics.ts#diagnosticTags`,
 *   prefixed by its `context`): a small integer, an enum (`ok`/`transport`/`timeout`),
 *   a latency bucket (`<1s`, `<5s`, …), and a boolean, all as strings.
 * - `api_base_origin` — `"same"` \| `"cross"` \| `"localhost"`
 *   (`fetchDiagnostics.ts#apiBaseOrigin`).
 * - `net_effective_type` — Chromium's `navigator.connection.effectiveType`
 *   (e.g. `"4g"`), omitted elsewhere.
 */
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
export type DiagnosticTagKey = (typeof DIAGNOSTIC_TAG_KEYS)[number];

/**
 * T02-D4's AE-only browser attribute channel (T07 fix round, controller
 * ruling; extended by T12/ADR-0042). `workers/o11y/src/normalise/
 * browser-attrs.ts#readAeOnlyAttrs` reads `HotAttrs` fields `toAePoint`
 * (§4/§5) accepts but §3 gives no resource-attribute or structured-metadata
 * slot to — `bucket`, `reason`, `fingerprint` (T07), and `kind` (reserved as
 * `hot.metric_kind`, since `hot.kind` is already the Faro item kind, §3),
 * `ref`, `area` (T12, ADR-0042) — under a `hot.<column>` key in a Faro
 * item's raw context/attributes, from the wire body, BEFORE `scrubTelemetry`
 * runs server-side. `route_class`/`model`/`provider`/`device` remain
 * unmapped — no browser call site needs them yet.
 *
 * A key listed here has to survive `scrub.ts#allowlistAttributes` (both the
 * browser-side pass, Faro's `beforeSend`, and the re-run server-side pass) or
 * the browser would never even transmit it — but it is deliberately NOT a
 * `RESOURCE_ATTRS` entry (no Loki label, no `blob1`–`blob8` slot) and NOT a
 * `STRUCTURED_METADATA_KEYS` entry either: same non-hoisted treatment
 * `DIAGNOSTIC_TAG_KEYS`'s own doc comment already describes —
 * `convert.ts#hoistAttributes` only recognises `RESOURCE_ATTR_KEYS` and
 * `STRUCTURED_KEY_SET` (structured metadata + diagnostic tags), so a key
 * listed here is silently dropped there and never reaches a stored
 * `resourceAttributes`/`attributes` field — harmless for `example.*`, which
 * is never stored at all (§6), but true of every other metric that might use
 * these columns too. Only `readAeOnlyAttrs`, reading the raw wire body
 * directly (before `hoistAttributes` ever runs), sees it.
 *
 * Not part of contract §3's prose (no matching paragraph in
 * `docs/observability-contract.md`, no `pipeline/telemetry-contract.test.mjs`
 * case): the controller's T07 fix-round ruling was to edit the doc only when
 * a DOCUMENTED name changes, and none of these six names was previously
 * documented anywhere in §3 — they are §4/§5 (AE layout / metric registry)
 * concepts that `HotAttrs` already names, gaining a transport path here, not
 * a new resource attribute or Loki label the doc's attribute table would
 * need to grow.
 */
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
export type AeOnlyAttributeKey = (typeof AE_ONLY_ATTRIBUTE_KEYS)[number];

/** One row per §3 resource attribute: its OTLP key, the Loki label it promotes to
 *  (`undefined` when the contract says "no"), and the Analytics Engine blob slot
 *  it fills (`attrs.ts` and `metrics.ts` agree on these — `AE_COLUMNS` in
 *  `metrics.ts` is the single source `sink.ts`/`inbox.ts` builders read). */
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

/**
 * §3's forbidden list is enforced as an allowlist, not a denylist (T00-D1, see
 * the task Outcome): `scrub.ts` keeps only `RESOURCE_ATTRS` keys,
 * `STRUCTURED_METADATA_KEYS` and `DIAGNOSTIC_TAG_KEYS`, and drops everything
 * else. That satisfies both this file's forbidden-attribute rule and ADR
 * §E.4's "drop unknown attributes" — every forbidden attribute (`url.full`,
 * geo, ASN, the user pseudonym, an email, an IP, a user-agent string) is
 * simply absent from the allowlist, and a future unknown attribute is dropped
 * by the same mechanism without a code change.
 */
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
 *  metric-specific (T00-D2). */
export interface CommonResourceAttrs {
  service_name: ServiceName;
  service_version: string;
  environment: Environment;
}
