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

/** No explicit event time in the payload (§C.2 names only `service`, `sha`,
 *  `cf_version_id`) — `rawEventTime` is always `""`, so the record's own
 *  timestamp is `receivedAtMs`, and a redelivery of the identical deploy
 *  event (the same CI step retried) still hashes identically. */
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
  let record: NormalisedRecord = {
    body: JSON.stringify({ event: "deploy", service: payload.service, sha: payload.sha, cf_version_id: payload.cf_version_id }),
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
    rawEventTime: "",
  });
  return { hash, record };
}
