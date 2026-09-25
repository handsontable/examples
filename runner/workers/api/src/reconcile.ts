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
import { computeBudgetState } from "./budget.js";
import { loadSettings } from "./settings.js";
import { emitPoint } from "./telemetry/points.js";
import { serviceEnvironment } from "./telemetry/resource.js";

/**
 * T04 (ADR-0041 §G): "`reconcile.ts` iterates over the scripts it
 * reconciles, `handsontable-demos-api` and `handsontable-demos-o11y`, and
 * writes each script's billing rows under distinct SKUs (`o11y_container`,
 * `o11y_workers`), so the per-SKU upsert never overwrites the app's rows."
 * `o11y_container` is not queried here — same reasoning this file's header
 * already gives for the app's own `container` sku ("container compute has
 * no public per-account analytics dataset"), so it stays estimate-only
 * (`o11y-usage.ts#O11yUsage.recordAwakeSeconds`). Only `workersInvocationsAdaptive`
 * (requests) is resolvable via GraphQL for the o11y script — no egress/R2
 * query for it, since ADR §G names exactly two o11y SKUs, not five.
 */
const RECONCILE_TARGETS = (env: Env) => [
  { script: env.CF_SCRIPT_NAME ?? "handsontable-demos-api", workersSku: "workers", app: true as const },
  { script: "handsontable-demos-o11y", workersSku: "o11y_workers", app: false as const },
];

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

async function queryUsage(env: Env, day: string, script: string): Promise<AccountUsage | null> {
  // Every dataset is filtered down to *this* Worker and *this* bucket. The
  // account is shared with a dozen other Workers, and an unfiltered query would
  // write whole-account usage into rows that outrank our own estimates — the
  // ceiling would then track everyone else's traffic. Scoping is not an
  // optimisation here, it is the difference between measuring the runner and
  // measuring the company.
  const query = `
    query RunnerUsage($account: String!, $day: Date!, $script: string!, $bucket: string!) {
      viewer {
        accounts(filter: { accountTag: $account }) {
          workersInvocationsAdaptive(limit: 10000, filter: { date: $day, scriptName: $script }) {
            sum { requests }
          }
          durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date: $day, scriptName: $script }) {
            sum { requests responseBodySize }
          }
          r2StorageAdaptiveGroups(limit: 100, filter: { date: $day, bucketName: $bucket }) {
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
    body: JSON.stringify({
      query,
      variables: {
        account: env.CF_ACCOUNT_ID,
        day,
        script,
        bucket: env.R2_BUCKET_NAME ?? "handsontable-demos",
      },
    }),
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
    // Includes the case where a dataset does not accept the scope filter we
    // sent. That must degrade to "no billing row for that sku" — writing an
    // unscoped, account-wide figure would be worse than keeping the estimate.
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
  const runStartedAt = Date.now();
  if (!env.CF_ANALYTICS_TOKEN) {
    console.log("[budget] CF_ANALYTICS_TOKEN not set — skipping reconciliation, estimates stand");
    void emitPoint(env, "reconcile.run", { count: 1, duration_ms: Date.now() - runStartedAt }, { outcome: "skipped" });
    return;
  }
  // Usage is processed a day in arrears, so yesterday is the freshest day that
  // is actually complete.
  const day = utcDayAgo(1);
  let sawError = false;
  // Sum of every `usd` figure written this run, app rows negative and o11y
  // rows positive would be nonsensical here — `reconcile.run`'s own §4
  // meaning is "usd (billing − estimate)", i.e. the drift this run
  // introduced versus what the estimator already had on the books for the
  // same (day, sku) pair. Approximated as the total billing usd written
  // this run (T04-D, see the task Outcome: the pre-write estimate figure
  // is not read back here, so this is "billing total", not a true delta —
  // still useful as a per-run cost signal, the drift itself is visible by
  // comparing this to the `estimate` rows in `/admin`).
  let billingUsdWritten = 0;

  for (const target of RECONCILE_TARGETS(env)) {
    try {
      const usage = await queryUsage(env, day, target.script);
      if (!usage) {
        console.warn(`[budget] no analytics data for ${day} (${target.script})`);
        continue;
      }

      const requests = sumOf(usage.workersInvocationsAdaptive, (g) => g.sum?.requests);
      if (requests !== null) {
        const usd = (requests / 1e6) * RATE.requestsUsdPerMillion;
        await writeBillingRow(env, day, target.workersSku, requests, usd);
        billingUsdWritten += usd;
      }

      if (target.app) {
        // Container egress leaves through the Sandbox Durable Object, so its
        // response body size is the closest real measure of the sku our own
        // counter can only approximate (it cannot see WebSocket/HMR frames).
        const egressBytes = sumOf(usage.durableObjectsInvocationsAdaptiveGroups, (g) => g.sum?.responseBodySize);
        if (egressBytes !== null) {
          const gb = egressBytes / 1e9;
          const usd = gb * RATE.egressUsdPerGB;
          await writeBillingRow(env, day, "egress", gb, usd);
          billingUsdWritten += usd;
        }

        // R2 bills per GB-month; one day of that is the daily slice of the bill.
        const storedBytes = sumOf(
          usage.r2StorageAdaptiveGroups,
          (g) => (g.max?.payloadSize ?? 0) + (g.max?.metadataSize ?? 0),
        );
        if (storedBytes !== null) {
          const gbMonths = (storedBytes / 1e9) / 30;
          const usd = gbMonths * RATE.r2UsdPerGBMonth;
          await writeBillingRow(env, day, "r2", gbMonths, usd);
          billingUsdWritten += usd;
        }

        console.log(
          `[budget] reconciled ${day} (${target.script}): requests=${requests ?? "n/a"} `
            + `egressBytes=${egressBytes ?? "n/a"} storedBytes=${storedBytes ?? "n/a"}`,
        );
      } else {
        console.log(`[budget] reconciled ${day} (${target.script}): requests=${requests ?? "n/a"}`);
      }
    } catch (err) {
      sawError = true;
      // A silently dead reconciliation means the ceiling quietly runs on
      // estimates forever — exactly the drift this job exists to prevent.
      Sentry.captureException(err, { tags: { context: "budget-reconcile", script: target.script } });
      console.error(
        `[budget] reconciliation failed for ${target.script}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  try {
    await env.DB.prepare("DELETE FROM cost_ledger WHERE day < ?1").bind(utcDayAgo(LEDGER_RETENTION_DAYS)).run();
  } catch { /* pruning is housekeeping, not correctness */ }

  void emitPoint(
    env,
    "reconcile.run",
    { count: 1, duration_ms: Date.now() - runStartedAt, usd: billingUsdWritten },
    { outcome: sawError ? "error" : "ok" },
  );
}

/**
 * Fire the panel-configured spend alerts, once per threshold per month.
 *
 * These are *our* alerts on *our* metered spend, which is the difference that
 * matters: Cloudflare's budget alerts are account-wide, so on a shared account
 * they answer "is the account spending a lot", not "is the runner". Sentry is
 * the delivery channel because it is the one alerting path this Worker already
 * has wired up.
 */
export async function checkCostAlerts(env: Env): Promise<void> {
  try {
    const settings = await loadSettings(env);
    if (!settings.alertsUsd.length) return;
    const state = await computeBudgetState(env, settings);
    const month = new Date().toISOString().slice(0, 7);

    for (const threshold of settings.alertsUsd) {
      if (state.spendUsd < threshold) continue;
      // The PK makes this a no-op when the threshold already fired this month,
      // so `meta.changes` is the "is this news?" test — no read needed.
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO cost_alerts (month, threshold, spend_usd, fired_at)
              VALUES (?1, ?2, ?3, ?4)`,
      ).bind(month, threshold, state.spendUsd, new Date().toISOString()).run();
      if (!result.meta?.changes) continue;

      const message =
        `[budget] month-to-date spend $${state.spendUsd.toFixed(2)} crossed the $${threshold} alert `
        + `(ceiling $${settings.limitUsd}, tier ${state.tier}, enforcement ${settings.enforce ? "on" : "off"})`;
      console.warn(message);
      Sentry.captureMessage(message, {
        level: threshold >= settings.limitUsd * 0.8 ? "error" : "warning",
        tags: { context: "budget-alert", threshold: String(threshold) },
        fingerprint: ["budget-alert", String(threshold), month],
      });
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { context: "budget-alert-check" } });
  }
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

// ---- ADR-0042 (example analytics) — the nightly example_daily rollup (T12) ----
//
// A nightly step in this same cron recomputes the PREVIOUS full UTC day from
// Analytics Engine into D1 `example_daily` (migration
// `workers/api/migrations/0008_example_daily.sql`, plus
// `0009_example_daily_downloaded.sql` — the `downloaded` column ADR-0042 §2
// always named but 0008 shipped without, per its own flagged gap). Three
// pieces, split so each is independently testable:
//
//   `queryExampleEventTotals` — the AE/ClickHouse read. Production reads
//   Cloudflare's Analytics Engine SQL API (`CF_ACCOUNT_ID` + `AE_SQL_TOKEN`,
//   the same credential shape `telemetry/resource.ts#getSink`'s local leg
//   already uses for the WRITE side); local mode reads the same ClickHouse
//   container T01/T09 write to. Kept to the T09-D5-documented safe SQL
//   subset (plain `sum`, no `COUNT()`, no per-panel `database` qualifier) —
//   unverified against a real Analytics Engine account (no credentials
//   available to this task, COMMON.md), same documented-default status
//   T02-D12's size caps have.
//
//   `pivotExampleDaily` — pure grouping: one row per (kind, ref, area,
//   framework, ht_major), one column per `example.*` metric. No I/O, fully
//   unit-tested without AE or D1.
//
//   `writeExampleDaily` — the D1 write. A real `DELETE FROM example_daily
//   WHERE day = ?1` followed by one `INSERT OR REPLACE` per row, in a single
//   `env.DB.batch` — NOT a bare `INSERT OR REPLACE` alone, which would leave
//   a (day, kind, ref, framework, ht_major) group from a PRIOR run's data
//   lingering when that group has zero events on a re-run (ADR-0042 §5:
//   "re-running it for a day replaces that day's rows").

const EXAMPLE_METRICS = [
  "example.open",
  "example.engaged",
  "example.forked",
  "example.saved",
  "example.shared",
  "example.downloaded",
] as const;
type ExampleMetric = (typeof EXAMPLE_METRICS)[number];

/** One (metric, taxonomy) group's total count, as the AE/ClickHouse query
 *  returns it — `total` is already `SUM(_sample_interval * double1)`, the
 *  contract's own reading rule (§4), never a bare `COUNT()`. */
export interface ExampleEventRow {
  metric: string;
  kind: string;
  ref: string;
  area: string;
  framework: string;
  ht_major: string;
  total: number;
}

/** One `example_daily` row, ready to bind into the D1 write. */
export interface ExampleDailyRow {
  day: string;
  kind: string;
  ref: string;
  area: string;
  framework: string;
  ht_major: string;
  opens: number;
  engaged: number;
  forked: number;
  saved: number;
  shared: number;
  downloaded: number;
}

type ExampleDailyCounterColumn = "opens" | "engaged" | "forked" | "saved" | "shared" | "downloaded";

const EXAMPLE_DAILY_COLUMN: Readonly<Record<ExampleMetric, ExampleDailyCounterColumn>> = {
  "example.open": "opens",
  "example.engaged": "engaged",
  "example.forked": "forked",
  "example.saved": "saved",
  "example.shared": "shared",
  "example.downloaded": "downloaded",
};

/** Pure: groups `rows` (one per metric per taxonomy tuple, as the AE query
 *  returns them) into one `ExampleDailyRow` per (kind, ref, area, framework,
 *  ht_major), pivoting each metric's total into its own counter column.
 *  `Math.round` — AE's `SUM(_sample_interval * double1)` is a sampling
 *  estimate, not necessarily an integer, but the D1 column is a plain
 *  INTEGER count. */
export function pivotExampleDaily(day: string, rows: readonly ExampleEventRow[]): ExampleDailyRow[] {
  const byKey = new Map<string, ExampleDailyRow>();
  for (const row of rows) {
    if (!(EXAMPLE_METRICS as readonly string[]).includes(row.metric)) continue;
    const key = `${row.kind}\u0000${row.ref}\u0000${row.framework}\u0000${row.ht_major}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        day,
        kind: row.kind,
        ref: row.ref,
        area: row.area,
        framework: row.framework,
        ht_major: row.ht_major,
        opens: 0,
        engaged: 0,
        forked: 0,
        saved: 0,
        shared: 0,
        downloaded: 0,
      };
      byKey.set(key, entry);
    }
    const column = EXAMPLE_DAILY_COLUMN[row.metric as ExampleMetric];
    entry[column] += Math.round(row.total);
  }
  return [...byKey.values()];
}

/** `INTERVAL '$interval' SECOND`-style quoting, T09-D5's own AE-vs-local
 *  ClickHouse finding: AE's SQL API documents quoted interval literals; a
 *  bare `SELECT ... WHERE timestamp >= '...'`/`< '...'` string-literal
 *  comparison against the `timestamp` column (no conversion function call at
 *  all) is the most conservative form both backends are documented to
 *  accept, so that is what this query uses rather than a
 *  `toDateTime64`/`parseDateTime` call this task could not verify against a
 *  real Analytics Engine account.
 */
function exampleEventsSql(dayStart: string, dayEnd: string): string {
  const metricList = EXAMPLE_METRICS.map((m) => `'${m}'`).join(", ");
  return (
    `SELECT index1 AS metric, blob17 AS kind, blob18 AS ref, blob19 AS area, ` +
    `blob6 AS framework, blob7 AS ht_major, sum(_sample_interval * double1) AS total ` +
    `FROM runner_events ` +
    `WHERE index1 IN (${metricList}) AND timestamp >= '${dayStart}' AND timestamp < '${dayEnd}' ` +
    `GROUP BY index1, blob17, blob18, blob19, blob6, blob7`
  );
}

/** The previous full UTC day, as `[start, end)` timestamps and the `day`
 *  string the D1 row is keyed by. */
export function previousUtcDay(now: Date = new Date()): { day: string; start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  return { day: start.toISOString().slice(0, 10), start: fmt(start), end: fmt(end) };
}

/** The AE/ClickHouse read (production: Analytics Engine SQL API; local:
 *  the same ClickHouse container the write side already reads/writes,
 *  `telemetry/resource.ts#getSink`'s local leg). **Always throws** on a
 *  failed or unconfigured read — it never degrades to `[]` (fix round C-I1:
 *  a silent `[]` here used to mean `writeExampleDaily` still ran its
 *  unconditional `DELETE` for the day with nothing to replace it, so a
 *  missing credential quietly erased that day's data forever). The caller
 *  (`rollupExampleDaily`) is the one place that decides what a thrown read
 *  means for the rest of the cron — it now means "skip the write entirely
 *  and alert," not "write zero rows." */
export async function queryExampleEventTotals(
  env: Env,
  dayStart: string,
  dayEnd: string,
): Promise<ExampleEventRow[]> {
  const sql = exampleEventsSql(dayStart, dayEnd);

  if (serviceEnvironment(env) !== "production") {
    const url = env.RUNNER_EVENTS_CLICKHOUSE_URL || "http://localhost:8123";
    const endpoint = `${url.replace(/\/$/, "")}/?query=${encodeURIComponent(`${sql} FORMAT JSONEachRow`)}`;
    const res = await fetch(endpoint, {
      headers: { "X-ClickHouse-User": "default", "X-ClickHouse-Key": env.AE_SQL_TOKEN ?? "" },
    });
    if (!res.ok) throw new Error(`queryExampleEventTotals: ClickHouse ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ExampleEventRow);
  }

  // C-I1: production's AE SQL leg needs `CF_ACCOUNT_ID` + `AE_SQL_TOKEN`
  // (contract §2's API-worker table). Neither is provisioned by default —
  // throw loudly instead of silently reading as "zero events today."
  if (!env.CF_ACCOUNT_ID || !env.AE_SQL_TOKEN) {
    throw new Error(
      "queryExampleEventTotals: AE_SQL_TOKEN and/or CF_ACCOUNT_ID not configured for the API worker " +
        "(contract §2, run-and-deploy.md 'Cost guardrails (one-time)') — refusing to treat this as zero example.* events",
    );
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AE_SQL_TOKEN}` },
    body: sql,
  });
  if (!res.ok) throw new Error(`queryExampleEventTotals: Analytics Engine SQL API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: unknown };
  // C-I1: a 200 with an unexpected shape (`data` missing or not an array —
  // an API contract change, a truncated response, ...) must not silently
  // degrade to "zero rows" either. `?? []` on a bare `undefined` would still
  // let `writeExampleDaily`'s DELETE run against nothing to replace it.
  if (!Array.isArray(body.data)) {
    throw new Error(`queryExampleEventTotals: Analytics Engine SQL API returned no "data" array: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data as ExampleEventRow[];
}

/** The D1 write: a real `DELETE` for the day, then one `INSERT OR REPLACE`
 *  per row, in a single `env.DB.batch` — see this section's header for why a
 *  bare `INSERT OR REPLACE` alone is not enough. A day with zero rows still
 *  issues the `DELETE` (clearing a previous run's rows for that day), so an
 *  all-quiet day is not silently left with stale data either. */
export async function writeExampleDaily(env: Env, day: string, rows: readonly ExampleDailyRow[]): Promise<void> {
  const statements = [
    env.DB.prepare("DELETE FROM example_daily WHERE day = ?1").bind(day),
    ...rows.map((r) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO example_daily
           (day, kind, ref, area, framework, ht_major, opens, engaged, forked, saved, shared, downloaded)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        r.day,
        r.kind,
        r.ref,
        r.area,
        r.framework,
        r.ht_major,
        r.opens,
        r.engaged,
        r.forked,
        r.saved,
        r.shared,
        r.downloaded,
      ),
    ),
  ];
  await env.DB.batch(statements);
}

/**
 * Recomputes the previous full UTC day's `example_daily` rows. Called from
 * the nightly cron (`runNightlyCron`, `workers/api/src/index.ts`) — one line
 * added there, per COMMON.md's "add the rollup call in reconcile.ts
 * minimally; T04 will resolve against it later."
 *
 * Never throws OUT of this function: a failed AE read or D1 write here must
 * not stop the rest of the nightly cron (`reconcileBilling`/
 * `checkCostAlerts`/`gcRevokedArtifacts`), the same resilience contract every
 * other function in this file already has. C-I1: a thrown/unconfigured read
 * (see `queryExampleEventTotals`) is caught here BEFORE `writeExampleDaily`
 * runs, so a bad day is skipped — never rolled up as zero and never deleted
 * — and reported loudly via the same unconditional `Sentry.captureException`
 * every other cron branch in this file uses (T05-D8: a cron failure inside
 * `ctx.waitUntil()` is structurally unreachable by `@sentry/cloudflare`'s own
 * auto-capture, so every branch here calls it explicitly).
 */
export async function rollupExampleDaily(env: Env): Promise<{ day: string; rows: number }> {
  const { day, start, end } = previousUtcDay();
  try {
    const totals = await queryExampleEventTotals(env, start, end);
    const rows = pivotExampleDaily(day, totals);
    await writeExampleDaily(env, day, rows);
    return { day, rows: rows.length };
  } catch (err) {
    Sentry.captureException(err, { tags: { context: "example-daily-rollup" } });
    return { day, rows: 0 };
  }
}
