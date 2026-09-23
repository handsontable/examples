// ADR §E.2: "The issue-alert webhook (new issue, regression, resolved)
// becomes a Loki line with issue id, title, release and link." Worker
// tenant. Sentry's internal-integration issue-alert payload
// (https://docs.sentry.io/product/integrations/integration-platform/webhooks/#issue-alerts):
// `{action, data: {issue: {id, shortId, title, level, permalink, ...}}}`
// roughly — every field read here is optional and falls back to `"unknown"`,
// since the exact shape is not pinned by this contract and a webhook replay
// (this task's fixture) is hand-built, not captured from a real Sentry
// account.

import { msToUnixNano, scrubTelemetry, type NormalisedRecord } from "@handsontable/demo-runtime/telemetry";
import type { Env, IngestItem } from "../env.js";
import { hashRecord } from "./hash.js";
import { withResourceAttrDefaults } from "./points.js";
import { scrubBodyText } from "./text-scrub.js";

function str(v: unknown, fallback = "unknown"): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** No signature-level shape validation here (the HMAC gate already
 *  authenticated the sender) — reads defensively, never throws on a missing
 *  field, so a Sentry payload shape drift becomes a less-informative log
 *  line, never a `500`. */
export async function processSentryPayload(
  payload: unknown,
  env: Env,
  receivedAtMs: number,
): Promise<IngestItem> {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const data = (typeof p["data"] === "object" && p["data"] !== null ? p["data"] : {}) as Record<string, unknown>;
  const issue = (typeof data["issue"] === "object" && data["issue"] !== null ? data["issue"] : {}) as Record<
    string,
    unknown
  >;

  const action = str(p["action"]);
  const issueId = str(issue["id"] ?? issue["shortId"]);
  const title = str(issue["title"]);
  const release = str((issue["lastRelease"] as Record<string, unknown> | undefined)?.["version"] ?? issue["release"]);
  const link = str(issue["permalink"] ?? issue["url"], "");

  const resourceAttributes = withResourceAttrDefaults(
    { "service.name": "demos-api", "service.version": release === "unknown" ? "unknown" : release },
    env,
  );
  let record: NormalisedRecord = {
    body: `sentry ${action}: ${title} [${issueId}] release=${release}${link ? ` ${link}` : ""}`,
    timeUnixNano: msToUnixNano(receivedAtMs),
    resourceAttributes,
    attributes: {},
  };
  // Fix round (finding A-I3): this record was stored with NO scrubbing at
  // all — Sentry's own issue `title`/`permalink` routinely embed a preview
  // host (a session credential), a query string, an email or a user-agent,
  // none of which contract §3 allows. Run the same authoritative pass every
  // other ingest path runs (`lite.ts`'s own order: convert, then
  // `scrubTelemetry`, then this worker's own extra text pass).
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
