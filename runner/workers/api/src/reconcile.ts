// Nightly reconciliation of the cost ledger (DEV-2030), run from the Worker's
// `scheduled` handler.
//
// budget.ts meters what this Worker can see from inside a request. That is an
// estimate and it will drift. This job pulls the prior day's real numbers from
// Cloudflare's GraphQL Analytics API and writes them as `source='billing'`
// rows, which outrank our estimates for the same (day, sku).
//
// Deliberately partial, and honest about it:
//   * container compute has no public per-account analytics dataset, so the
//     'container' sku keeps our own estimate. It is also the one sku Cloudflare
//     already caps for us via `containers.max_instances`.
//   * allowances (1 TB egress, 10M requests, 25 GiB-hours) are NOT deducted.
//     Pricing gross overstates spend early in the month, which is the safe
//     direction for a ceiling.
//
// Requires a read-only token: `wrangler secret put CF_ANALYTICS_TOKEN`
// (Account -> Account Analytics -> Read; nothing else). Without it the job
// logs and returns, leaving the estimator in charge.

import * as Sentry from "@sentry/cloudflare";
import type { Env } from "./env.js";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Same rate table as budget.ts, for the SKUs this job can actually resolve. */
const RATE = {
  egressUsdPerGB: 0.025,
  requestsUsdPerMillion: 0.30,
  r2UsdPerGBMonth: 0.015,
} as const;

/** Retention for ledger rows; long enough to compare months, short enough that
 *  the table stays trivially small. */
const LEDGER_RETENTION_DAYS = 400;

const utcDayAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

interface AccountUsage {
  workersInvocationsAdaptive?: { sum?: { requests?: number } }[];
  durableObjectsInvocationsAdaptiveGroups?: { sum?: { requests?: number; responseBodySize?: number } }[];
  r2StorageAdaptiveGroups?: { max?: { payloadSize?: number; metadataSize?: number } }[];
}

/**
 * Sum a metric across every group a dataset returned. Fields are read
 * defensively: a dataset Cloudflare renames or a field our token cannot see
 * must degrade to "no billing row for that sku", never to a thrown cron.
 */
function sumOf<T>(groups: T[] | undefined, pick: (g: T) => number | undefined): number | null {
  if (!groups?.length) return null;
  let total = 0;
  let sawValue = false;
  for (const g of groups) {
    const v = pick(g);
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      sawValue = true;
    }
  }
  return sawValue ? total : null;
}

async function queryUsage(env: Env, day: string): Promise<AccountUsage | null> {
  const query = `
    query RunnerUsage($account: String!, $day: Date!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          workersInvocationsAdaptive(limit: 10000, filter: { date: $day }) {
            sum { requests }
          }
          durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date: $day }) {
            sum { requests responseBodySize }
          }
          r2StorageAdaptiveGroups(limit: 100, filter: { date: $day }) {
            max { payloadSize metadataSize }
          }
        }
      }
    }`;

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { account: env.CF_ACCOUNT_ID, day } }),
  });
  if (!res.ok) throw new Error(`analytics query failed: ${res.status} ${await res.text()}`);

  const payload = (await res.json()) as {
    data?: { viewer?: { accounts?: AccountUsage[] } };
    errors?: { message?: string }[];
  };
  // A partial result is still useful — log the failed selections and price what
  // did come back. Field names differ per dataset version; the observe week is
  // when we find out which ones this account exposes.
  if (payload.errors?.length) {
    console.warn("[budget] analytics query returned errors:", payload.errors.map((e) => e.message).join("; "));
  }
  return payload.data?.viewer?.accounts?.[0] ?? null;
}

async function writeBillingRow(env: Env, day: string, sku: string, units: number, usd: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cost_ledger (day, sku, source, units, usd, updated_at)
          VALUES (?1, ?2, 'billing', ?3, ?4, ?5)
     ON CONFLICT(day, sku, source) DO UPDATE
          SET units = ?3, usd = ?4, updated_at = ?5`,
  ).bind(day, sku, units, usd, Date.now()).run();
}

/**
 * Replace yesterday's estimates with reconciled figures, prune old rows, and
 * refresh the cached budget state. Never throws: a broken cron must not be the
 * reason the ceiling stops working.
 */
export async function reconcileBilling(env: Env): Promise<void> {
  if (!env.CF_ANALYTICS_TOKEN) {
    console.log("[budget] CF_ANALYTICS_TOKEN not set — skipping reconciliation, estimates stand");
    return;
  }
  // Usage is processed a day in arrears, so yesterday is the freshest day that
  // is actually complete.
  const day = utcDayAgo(1);

  try {
    const usage = await queryUsage(env, day);
    if (!usage) {
      console.warn(`[budget] no analytics data for ${day}`);
      return;
    }

    const requests = sumOf(usage.workersInvocationsAdaptive, (g) => g.sum?.requests);
    if (requests !== null) {
      await writeBillingRow(env, day, "workers", requests, (requests / 1e6) * RATE.requestsUsdPerMillion);
    }

    // Container egress leaves through the Sandbox Durable Object, so its
    // response body size is the closest real measure of the sku our own
    // counter can only approximate (it cannot see WebSocket/HMR frames).
    const egressBytes = sumOf(usage.durableObjectsInvocationsAdaptiveGroups, (g) => g.sum?.responseBodySize);
    if (egressBytes !== null) {
      const gb = egressBytes / 1e9;
      await writeBillingRow(env, day, "egress", gb, gb * RATE.egressUsdPerGB);
    }

    // R2 bills per GB-month; one day of that is the daily slice of the bill.
    const storedBytes = sumOf(
      usage.r2StorageAdaptiveGroups,
      (g) => (g.max?.payloadSize ?? 0) + (g.max?.metadataSize ?? 0),
    );
    if (storedBytes !== null) {
      const gbMonths = (storedBytes / 1e9) / 30;
      await writeBillingRow(env, day, "r2", gbMonths, gbMonths * RATE.r2UsdPerGBMonth);
    }

    console.log(
      `[budget] reconciled ${day}: requests=${requests ?? "n/a"} egressBytes=${egressBytes ?? "n/a"} storedBytes=${storedBytes ?? "n/a"}`,
    );
  } catch (err) {
    // A silently dead reconciliation means the ceiling quietly runs on
    // estimates forever — exactly the drift this job exists to prevent.
    Sentry.captureException(err, { tags: { context: "budget-reconcile" } });
    console.error("[budget] reconciliation failed:", err instanceof Error ? err.message : String(err));
  }

  try {
    await env.DB.prepare("DELETE FROM cost_ledger WHERE day < ?1").bind(utcDayAgo(LEDGER_RETENTION_DAYS)).run();
  } catch { /* pruning is housekeeping, not correctness */ }
}

/**
 * Delete R2 artifacts of demos revoked longer ago than `BUDGET_R2_GC_DAYS`.
 *
 * The only unbounded-growth path in R2: `DELETE /api/demos/:id` marks a demo
 * revoked (410 thereafter) but its build output stays forever. Nothing else in
 * the bucket is eligible — shares are immutable by design (ADR-0006), and the
 * per-version dependency cache the DEV-2030 brief worried about does not exist
 * (deps are baked into the container image, not stored in R2).
 *
 * Off by default (`0`), because it deletes bytes: turn it on deliberately.
 * `build_cache` rows pointing at a purged prefix are deleted in the same pass —
 * a cached build whose objects are gone would otherwise be "reused" into an
 * empty demo.
 */
export async function gcRevokedArtifacts(env: Env): Promise<void> {
  const days = Number(env.BUDGET_R2_GC_DAYS ?? 0);
  if (!Number.isFinite(days) || days <= 0) return;

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, r2_prefix FROM demos
        WHERE revoked = 1 AND revoked_at IS NOT NULL AND revoked_at < ?1
          AND artifacts_purged_at IS NULL
        LIMIT 50`,
    ).bind(cutoff).all<{ id: string; r2_prefix: string }>();

    for (const row of results ?? []) {
      // Belt and braces: only ever touch a prefix this demo owns.
      if (row.r2_prefix !== `demos/${row.id}/`) continue;
      let cursor: string | undefined;
      let deleted = 0;
      do {
        const listed = await env.ARTIFACTS.list({ prefix: row.r2_prefix, cursor });
        for (const obj of listed.objects) {
          await env.ARTIFACTS.delete(obj.key);
          deleted++;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      await env.DB.prepare("DELETE FROM build_cache WHERE r2_prefix = ?1").bind(row.r2_prefix).run();
      // The demos row stays (revoked = 1 is what makes /d/:id answer 410);
      // the stamp is what keeps the next pass from re-listing an empty prefix.
      await env.DB.prepare("UPDATE demos SET artifacts_purged_at = ?1 WHERE id = ?2")
        .bind(new Date().toISOString(), row.id).run();
      console.log(`[budget] purged ${deleted} artifact(s) for revoked demo ${row.id}`);
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { context: "budget-r2-gc" } });
  }
}
