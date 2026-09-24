// ADR §C.2: "each deploy job posts `{service, sha, cf_version_id}` to
// `/telemetry/deploy`, which becomes a Loki line and a Grafana annotation."
// Worker tenant (§8: "worker" — every non-browser source).
//
// T02-D — record identity and body shape (see the task Outcome; pinned by
// the controller against T09's Runner-overview annotation query, which is
// already written against this shape): the record's **resource** attributes
// are the o11y worker's own self-identity (`service.name=demos-o11y`,
// `hot.surface=o11y`, via `withResourceAttrDefaults`'s
// `SURFACE_BY_SERVICE_NAME` mapping) — a deploy event is an annotation the
// o11y worker *reports about* a third-party deploy, not a record the
// deploying service itself emitted, the same way `o11y.ingest`'s own
// resource identity is always the o11y worker's (`normalise/respond.ts#o11ySelfIdentity`).
// The **body** is `JSON.stringify({event:"deploy", service, sha,
// cf_version_id})` — `event: "deploy"` is this task's own addition (not
// named in ADR §C.2's `{service, sha, cf_version_id}`), added so a Grafana
// annotation query can filter on it without a body-text regex.

import { msToUnixNano, scrubTelemetry, type NormalisedRecord } from "@handsontable/demo-runtime/telemetry";
import type { Env, IngestItem } from "../env.js";
import { hashRecord } from "./hash.js";
import { o11ySelfIdentity } from "./respond.js";
import { withResourceAttrDefaults } from "./points.js";
import { scrubBodyText } from "./text-scrub.js";

export interface DeployPayload {
  service: string;
  sha: string;
  cf_version_id: string;
}

export function isDeployPayload(v: unknown): v is DeployPayload {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d["service"] === "string" && typeof d["sha"] === "string" && typeof d["cf_version_id"] === "string";
}

// Fix round (finding A-M7): the payload itself carries no event time (§C.2
// names only `service`, `sha`, `cf_version_id`), and there is no per-delivery
// header either — this is a plain authenticated POST from a CI step, not a
// webhook system with its own delivery id. `rawEventTime` used to be a fixed
// `""`, so two genuinely different deploys that happen to redeploy the exact
// same `{service, sha, cf_version_id}` (e.g. a no-op redeploy, or a rollback
// back to a previous version) inside the same 24h dedupe window
// (`DEDUPE_WINDOW_MS`) hashed identically and the second one silently
// vanished. Bucketing the worker's own receive time to the minute gives each
// such event a distinct `rawEventTime` while still collapsing a genuine
// network-level retry of the same POST, which lands well inside the same
// one-minute bucket.
const RAW_EVENT_TIME_BUCKET_MS = 60_000;

function bucketedReceivedAt(receivedAtMs: number): string {
  return String(Math.floor(receivedAtMs / RAW_EVENT_TIME_BUCKET_MS));
}

export async function processDeployPayload(
  payload: DeployPayload,
  env: Env,
  receivedAtMs: number,
): Promise<IngestItem> {
  const identity = o11ySelfIdentity(env);
  const resourceAttributes = withResourceAttrDefaults(
    {
      "service.name": identity.service_name,
      "service.version": identity.service_version,
    },
    env,
  );
  // B-I1: `cf_version_id` can arrive as `""` — `isDeployPayload` only checks
  // it is a string, and `master.yml`'s own `version_id=$(grep ...) || true`
  // deliberately lets a wrangler wording change through as an empty string
  // rather than failing the deploy job after the deploy already shipped
  // (that workflow now also emits its own `::warning::` for this — see
  // B-I1's fix in `.github/workflows/master.yml`). This ingest path must
  // NEVER reject the event over it (the deploy still happened and is still
  // worth recording), but an empty version id silently corrupts the ADR
  // §C.2 deploy-correlation record — mark it both ways: a `console.warn`
  // (reaches Workers Logs -> Loki, same as every other anomaly in this
  // file) and a body field (NOT a §4/§5 `attributes` key — that bag is a
  // fixed, contract-governed schema via `ALLOWED_ATTRIBUTE_KEYS`, which
  // `scrubTelemetry` below strips anything off of; the body is free JSON,
  // so a marker there survives scrubbing and is still queryable in
  // Loki/Grafana via a body filter, e.g. `cf_version_id_missing":true`).
  const versionIdMissing = payload.cf_version_id.length === 0;
  if (versionIdMissing) {
    console.warn(`[o11y] deploy event for "${payload.service}" (sha ${payload.sha}) arrived with an empty cf_version_id`);
  }
  let record: NormalisedRecord = {
    body: JSON.stringify({
      event: "deploy",
      service: payload.service,
      sha: payload.sha,
      cf_version_id: payload.cf_version_id,
      ...(versionIdMissing ? { cf_version_id_missing: true } : {}),
    }),
    timeUnixNano: msToUnixNano(receivedAtMs),
    resourceAttributes,
    attributes: {},
  };
  // Fix round (finding A-I3): "in both processors" — CI-controlled input is
  // lower risk than Sentry's (`sentry.ts`'s own doc comment), but the OIDC
  // gate authenticates the *deployer*, not the content of `service`/`sha`;
  // running the same authoritative scrub costs nothing here and keeps every
  // worker-tenant record on the same guarantee.
  record = scrubTelemetry(record)!;
  record.body = scrubBodyText(record.body);
  const hash = await hashRecord({
    body: record.body,
    resourceAttributes: record.resourceAttributes,
    attributes: {},
    rawEventTime: bucketedReceivedAt(receivedAtMs),
  });
  return { hash, record };
}
