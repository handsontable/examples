// The contract's `HotAttrs` (`toAePoint`'s third argument) has fields —
// `reason`, `route_class`, `fingerprint`, `model`, `provider`, `device`,
// `bucket`, `ref`, `area` — that `attrs.ts#ALLOWED_ATTRIBUTE_KEYS` does not
// list, because that allowlist governs what a *stored, Loki-bound* record
// may carry (§3's small resource/structured-metadata set), not what
// Analytics Engine's §4 layout accepts. This module reads these under a
// `hot.<column>` key in the item's `context`/`attributes`, mirroring the
// existing `hot.*` convention — with one exception: `hot.kind` is already
// reserved (§3: "the Faro item kind") and `convert.ts#faroItemToRecord`
// always overwrites it with `item.type`, so AE slot `blob17` (ADR-0042's
// "docs, starter, saved, import, payload" kind) is read from
// `hot.metric_kind` instead.
//
// Read from the item's **raw, pre-scrub** context/attributes — these values
// never reach storage (only `toAePoint`, never `buildResourceLogs`), so
// `scrubTelemetry`'s allowlist would otherwise strip every one of them
// before this module ever sees them. Each value still gets this module's
// own light sanitisation (`redactPreviewHosts` + `stripQueryAndFragment` +
// a length cap), since it is client-controlled and never passed through
// the authoritative scrubber.

import { redactPreviewHosts } from "@handsontable/demo-runtime/monitor";
import { type HotAttrs, stripQueryAndFragment } from "@handsontable/demo-runtime/telemetry";

const MAX_ATTR_LEN = 256;

/** `HotAttrs` field name → the raw `hot.<key>` context key this module reads
 *  it from. `hot.kind`, `hot.demo_id`, `hot.surface`, `hot.tier`,
 *  `hot.framework`, `hot.ht_major`, `hot.outcome` are deliberately absent —
 *  each of those is already part of the allowlisted resource/structured-
 *  metadata set and is read off the *converted* record instead (see
 *  `normalise/faro.ts`), not duplicated here. */
const AE_ONLY_KEYS: ReadonlyArray<[keyof HotAttrs, string]> = [
  ["reason", "hot.reason"],
  ["route_class", "hot.route_class"],
  ["fingerprint", "hot.fingerprint"],
  ["model", "hot.model"],
  ["provider", "hot.provider"],
  ["device", "hot.device"],
  ["bucket", "hot.bucket"],
  ["ref", "hot.ref"],
  ["area", "hot.area"],
  ["kind", "hot.metric_kind"],
];

function sanitize(value: string): string {
  return redactPreviewHosts(stripQueryAndFragment(value)).slice(0, MAX_ATTR_LEN);
}

/** Extracts the AE-only `HotAttrs` fields from a raw (pre-scrub) Faro item's
 *  merged `context`/`attributes` bag. Returns `{}` for `undefined`/empty
 *  input — every field stays optional, `toAePoint` only reads what a given
 *  metric's §5 row lists. */
export function readAeOnlyAttrs(raw: Record<string, string> | undefined): HotAttrs {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [field, key] of AE_ONLY_KEYS) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) out[field] = sanitize(value);
  }
  return out as HotAttrs;
}
