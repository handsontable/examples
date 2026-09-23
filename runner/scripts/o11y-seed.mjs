#!/usr/bin/env node
// scripts/o11y-seed.mjs
//
// T09 (runner/tasks/o11y/T09-dashboards.md): a synthetic generator that writes
// realistic contract-shaped rows to local ClickHouse (Analytics Engine stand-in,
// docs/observability-contract.md §10) and OTLP log records straight to Loki
// (both tenants), so the provisioned dashboards under
// containers/o11y/grafana/dashboards/ have something to render before the real
// emitters (T02, T05–T08) land.
//
// Every AE point is built with `toAePoint` (packages/runtime/src/telemetry) —
// the same producer contract the o11y worker and the API worker will use — so
// a seed run can never write a shape the dashboards' lint test
// (pipeline/o11y-dashboards.test.mjs) would reject as "unknown column" or an
// out-of-set outcome. Every Loki log line is built with `buildResourceLogs`,
// the exact OTLP `ResourceLogs` shape `InboxWriter` produces from a real Faro
// item or beacon (contract §6, §8) — this script talks to Loki's
// `/otlp/v1/logs` endpoint directly (T01's local stand-in has no Worker in
// front locally), the same endpoint the real ingest path forwards to.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build` (this
// file imports the telemetry module from `packages/runtime/dist/`, the same
// convention `pipeline/telemetry-contract.test.mjs` and friends use).
//
// Usage: node scripts/o11y-seed.mjs
// Config (env, all optional — defaults match the contract's local port
// defaults, §1, so this works against `pnpm o11y:dev` once T03 ships it; pass
// the O11Y_*_PORT overrides used by `docker compose -f
// containers/o11y/compose.yml up` for a task's own port block, COMMON.md
// rule 5):
//   O11Y_CLICKHOUSE_URL        full ClickHouse HTTP base URL (overrides the port var)
//   O11Y_CLICKHOUSE_PORT       default 8123
//   O11Y_CLICKHOUSE_USER       default "default"
//   O11Y_CLICKHOUSE_PASSWORD   default AE_SQL_TOKEN, else "local-dev-token"
//   O11Y_LOKI_URL              full Loki HTTP base URL (overrides the port var)
//   O11Y_LOKI_PORT             default 3100
//   O11Y_SEED_WINDOW_MINUTES   how far back points/lines are spread, default 240 (4h)
//   O11Y_SEED_POINTS_PER_METRIC per-metric AE point count, default 60
//   O11Y_SEED_TRUNCATE         "0" to append instead of truncating runner_events first, default truncate
//
// Exit code 0 = every write batch succeeded (checked by status, not just "fetch
// didn't throw" — sink.ts's own documented trap). Non-zero = at least one
// batch failed; the failing response body is printed. Run through `rtk proxy`
// per .superpowers/sdd/README/COMMON.md.

import {
  METRIC_NAMES,
  METRICS,
  DEVICE_CLASSES,
  toAePoint,
  clickhouseTimestamp,
  buildResourceLogs,
  msToUnixNano,
} from "../packages/runtime/dist/telemetry/index.js";

// ---- Config -----------------------------------------------------------------

const CH_URL =
  process.env.O11Y_CLICKHOUSE_URL ?? `http://localhost:${process.env.O11Y_CLICKHOUSE_PORT ?? "8123"}`;
const CH_USER = process.env.O11Y_CLICKHOUSE_USER ?? "default";
const CH_PASSWORD =
  process.env.O11Y_CLICKHOUSE_PASSWORD ?? process.env.AE_SQL_TOKEN ?? "local-dev-token";
const LOKI_URL = process.env.O11Y_LOKI_URL ?? `http://localhost:${process.env.O11Y_LOKI_PORT ?? "3100"}`;
const WINDOW_MS = Number(process.env.O11Y_SEED_WINDOW_MINUTES ?? "240") * 60_000;
const POINTS_PER_METRIC = Number(process.env.O11Y_SEED_POINTS_PER_METRIC ?? "60");
const TRUNCATE_FIRST = process.env.O11Y_SEED_TRUNCATE !== "0";
const TABLE = "runner_events";

const now = Date.now();

// ---- Small deterministic-ish RNG helpers (no dependency; seeded so repeat
// runs look similar, not bit-identical — bit-identical is not a goal here) ---

let seed = 42;
function rand() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
/** Weighted pick: `weights` parallel to `values`, e.g. mostly-success outcomes. */
function weighted(values, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < values.length; i++) {
    r -= weights[i];
    if (r <= 0) return values[i];
  }
  return values[values.length - 1];
}
function randomTimestamp() {
  return now - Math.floor(rand() * WINDOW_MS);
}

// Loki (unlike the local ClickHouse stand-in) rejects an entry that lands
// more than roughly 20 minutes behind the highest timestamp already ingested
// for its exact label-set stream — measured live against T01's real
// container: a first seed run advances a stream's high-water mark to "now",
// and a second run's random backfill across the full O11Y_SEED_WINDOW_MINUTES
// then gets rejected wholesale as "entry too far behind". AE points don't
// have this constraint (ClickHouse accepts any historical timestamp), so only
// the Loki-bound generators use this narrower, safely-under-the-tolerance
// window — keeping `node scripts/o11y-seed.mjs` re-runnable against an
// already-seeded box, which the full-window spread would not be.
const LOKI_RECENT_WINDOW_MS = Math.min(WINDOW_MS, 15 * 60_000);
function randomRecentTimestamp() {
  return now - Math.floor(rand() * LOKI_RECENT_WINDOW_MS);
}
function hex(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

// ---- Representative open-set values (contract §3: framework and most blobs
// are open strings; ht_major is the one closed set among them, HT_MAJORS) ----

const FRAMEWORKS = ["react", "vue3", "angular", "vanilla-js", "next"];
const HT_MAJORS_SEEN = ["17", "18", "19", "next"]; // "next" gets highlighted on Version health
const BUCKETS = ["17.2", "18.1", "19.0", "next"];
const DEMO_IDS = ["r-react-18-0-0", "r-vue3-next", "r-angular-19", "r-vanilla-js-17-2", "r-next-18-1"];
const ROUTE_CLASSES = ["api/versions", "api/demos", "api/chat", "api/theme", "api/import"];
const MODELS = ["gpt-4o-mini", "claude-3-5-sonnet"];
const PROVIDERS = ["jsfiddle", "stackblitz"];
const KINDS = ["docs", "starter", "saved", "import", "payload"];
const REFS = ["/guide/getting-started", "/guide/formulas", "/guide/columns", "starter:react-18"];
const AREAS = ["grid", "columns", "formulas", "themes"];
const ALERT_RULES = ["at_capacity_rate", "preview_ready_rate", "session_start_p95", "inbox_backlog_age"];

function randomFramework() {
  return pick(FRAMEWORKS);
}
function randomHtMajor() {
  return weighted(HT_MAJORS_SEEN, [3, 4, 3, 1]); // "next" a minority, as in real traffic
}
function fingerprintFor(context) {
  return `${context}:${hex(16)}`;
}

// service_name per "Emitted by" (§5) — genuinely fixed per metric, unlike
// surface/tier below, which `toAePoint`'s closed sets (§3 SURFACES/TIERS)
// allow to vary and which a real emitter's traffic would vary too.
function serviceNameFor(emittedBy) {
  if (emittedBy.startsWith("browser")) return "demos-authoring";
  if (emittedBy.startsWith("o11y worker")) return "demos-o11y";
  return "demos-api"; // "API worker", "API worker */5", "API worker cron"
}

/** Picked fresh per point (T09-D2, revised) — a call site that hoisted this
 *  outside the per-point loop gave every point for a metric the identical
 *  surface/tier, collapsing e.g. "Preview-ready rate by tier" to one series
 *  and starving every surface-filtered Docs-embeds panel of `embed`/`d`
 *  rows (found the same way as T09-D2: querying the seeded rows directly).
 *  Weighted toward `authoring` (the primary editing surface) but with real
 *  weight on `embed`/`d`/`share` so beacon-only metrics (`web_vital`,
 *  `error.uncaught`) have something for those surfaces too. */
function pickSurface(emittedBy) {
  if (emittedBy.startsWith("browser")) {
    return weighted(["authoring", "share", "d", "embed"], [5, 2, 2, 3]);
  }
  if (emittedBy.startsWith("o11y worker")) return "o11y";
  return "api"; // "API worker" and friends
}

function pickTier(emittedBy) {
  if (emittedBy.startsWith("browser")) return pick(["1", "2"]);
  if (emittedBy.startsWith("o11y worker")) return "none";
  return pick(["1", "2", "static", "none"]); // "API worker" and friends
}

/** One valid value for `column` on metric `def`, respecting its closed set
 *  when §5 declares one (`def.values[column]`), else a representative open
 *  value. Mirrors `toAePoint`'s own closed-set enforcement (metrics.ts) so a
 *  seeded point never throws there. */
function valueFor(column, def) {
  const closed = def.values?.[column];
  if (closed) {
    // Bias toward the "good" end of the outcome/reason list — the first
    // value in every §5 outcomes list is the success case — so dashboards
    // read like healthy traffic with a visible error tail, not 50/50 noise.
    const weights = closed.map((_, i) => (i === 0 ? closed.length * 2 : 1));
    return weighted([...closed], weights);
  }
  switch (column) {
    case "framework":
      return randomFramework();
    case "ht_major":
      return randomHtMajor();
    case "route_class":
      return pick(ROUTE_CLASSES);
    case "fingerprint":
      return fingerprintFor("demo-runtime");
    case "demo_id":
      return pick(DEMO_IDS);
    case "model":
      return pick(MODELS);
    case "provider":
      return pick(PROVIDERS);
    case "device":
      return pick(DEVICE_CLASSES);
    case "bucket":
      return pick(BUCKETS);
    case "kind":
      return pick(KINDS);
    case "ref":
      return pick(REFS);
    case "area":
      return pick(AREAS);
    case "reason":
      // Open per metric (e.g. version.switch's "from" framework, budget.gauge's
      // tier, o11y.alert's rule id) — good enough as a representative string.
      return pick([...ALERT_RULES, ...FRAMEWORKS]);
    default:
      return "seed";
  }
}

/** Doubles for `column` on metric `name` — plausible magnitudes per §4's
 *  meaning column, not just zero. */
function doubleFor(column, name) {
  switch (column) {
    case "count":
      // `toAePoint` itself defaults a *missing* `count` to 1 (§4's "1 per
      // point unless pre-aggregated"), but only for `undefined` — `0` is a
      // real, deliberate value to it (`0 ?? 1` is `0`), so this generator
      // must never hand back the `default: 0` case for "count" explicitly,
      // or every metric whose §5 row lists "count" among its doubles (most
      // of them) would silently zero out `double1` (T09-D2, found by
      // querying the seeded rows directly — see Outcome).
      return 1;
    case "duration_ms":
      if (name === "session.start_ms" || name === "session.start" || name === "container.boot_ms") {
        return Math.round(400 + rand() * 8000);
      }
      if (name === "preview.ready_ms" || name === "bucket.resolve_ms") {
        return Math.round(300 + rand() * 4000);
      }
      return Math.round(20 + rand() * 1500);
    case "value":
      if (name === "web_vital") return Math.round(rand() * 3000);
      if (name === "pool.gauge") return Math.round(rand() * 8);
      if (name === "budget.gauge") return Math.round(rand() * 100);
      if (name === "session.end") return Math.round(30 + rand() * 3000); // awake seconds
      if (name === "o11y.backlog") return Math.round(rand() * 3600); // oldest age s
      if (name === "o11y.drain") return Math.round(rand() * 5); // re-opened keys
      return Math.round(rand() * 100);
    case "usd":
      return Number((rand() * 0.2).toFixed(4));
    case "tokens_in":
      return Math.round(50 + rand() * 2000);
    case "tokens_out":
      return Math.round(20 + rand() * 800);
    case "bytes":
      return Math.round(500 + rand() * 500_000);
    case "cap":
      return name === "pool.gauge" ? 10 : 100;
    default:
      return 0;
  }
}

// ---- ClickHouse (Analytics Engine stand-in) ----------------------------------

function pointToRow(point, timestampMs) {
  // Mirrors `clickhouseSink`'s own row shape (packages/runtime/src/telemetry/
  // sink.ts) column for column — that function only ever stamps `new Date()`
  // (fire-and-forget production writes have no reason to backdate a point),
  // so it has no seam for a synthetic historical timestamp. Reusing
  // `clickhouseTimestamp` keeps the one genuinely tricky part (epoch-ms,
  // never seconds or a formatted string — see sink.ts's doc comment for the
  // three-way measurement behind that) single-sourced; only the thin
  // row-assembly around it is duplicated here (T09-D1, see Outcome).
  const row = {
    timestamp: clickhouseTimestamp(new Date(timestampMs)),
    _sample_interval: 1,
    index1: point.indexes[0] ?? "",
  };
  point.blobs.forEach((v, i) => {
    if (v !== "") row[`blob${i + 1}`] = v;
  });
  point.doubles.forEach((v, i) => {
    if (v !== 0) row[`double${i + 1}`] = v;
  });
  return row;
}

async function chQuery(query, { asPost } = {}) {
  const url = `${CH_URL.replace(/\/$/, "")}/?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": CH_USER,
      "X-ClickHouse-Key": CH_PASSWORD,
      "Content-Type": "text/plain",
    },
    body: asPost ?? "",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickHouse query failed (${res.status}): ${body.slice(0, 400)}\nquery: ${query}`);
  }
  return res.text();
}

async function chInsertBatch(rows) {
  if (rows.length === 0) return;
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await chQuery(`INSERT INTO ${TABLE} FORMAT JSONEachRow`, { asPost: body });
}

// ---- Loki (OTLP log records) --------------------------------------------------

async function pushResourceLogs(tenant, records) {
  if (records.length === 0) return;
  // Loki rejects an entry that arrives "too far behind" the newest entry
  // already ingested **for that same label stream** — measured live against
  // T01's exact container: pushing entries newest-first for a repeated label
  // set (e.g. every deploy annotation shares one stream) rejected everything
  // but the first with "entry too far behind". Sorting the whole batch
  // ascending by time is a superset-safe fix (a sorted sequence is sorted
  // within every one of its label-set subsequences too).
  const sorted = [...records].sort((a, b) => (a.timeUnixNano < b.timeUnixNano ? -1 : 1));
  const body = JSON.stringify({ resourceLogs: sorted.map((r) => buildResourceLogs(r)) });
  const res = await fetch(`${LOKI_URL.replace(/\/$/, "")}/otlp/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Scope-OrgID": tenant },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Loki OTLP push failed for tenant "${tenant}" (${res.status}): ${text.slice(0, 400)}`);
  }
}

function normalisedRecord({ body, timestampMs, resourceAttrs, attrs, severityText }) {
  return {
    body,
    timeUnixNano: msToUnixNano(timestampMs),
    resourceAttributes: resourceAttrs,
    attributes: attrs,
    severityText,
  };
}

// ---- Generation ---------------------------------------------------------------

/** Gauges/crons that read as a real time series only when sampled on a
 *  regular cadence, not scattered randomly (§5: "every 5 min" / cron). */
const PERIODIC_METRICS = new Set(["pool.gauge", "budget.gauge", "o11y.backlog"]);

async function seedAePoints() {
  const rows = [];
  const chunks = [];
  const flush = () => {
    if (rows.length === 0) return;
    chunks.push(chInsertBatch(rows.splice(0, rows.length)));
  };

  for (const name of METRIC_NAMES) {
    const def = METRICS[name];
    const service_name = serviceNameFor(def.emittedBy);

    const count = PERIODIC_METRICS.has(name) ? Math.max(1, Math.floor(WINDOW_MS / 300_000)) : POINTS_PER_METRIC;

    for (let i = 0; i < count; i++) {
      const timestampMs = PERIODIC_METRICS.has(name) ? now - i * 300_000 : randomTimestamp();

      const attrs = { service_name, environment: "local" };
      const hot = {};
      // `surface`/`tier` are picked fresh per point (see `pickSurface`'s
      // comment) — a metric whose §5 row pins a narrower closed set for
      // `surface` (only `preview.runtime_error`, to `demo-runtime`) wins;
      // `valueFor` already reads `def.values` first for exactly that case.
      if (def.blobs.includes("surface")) {
        hot.surface = def.values?.surface ? valueFor("surface", def) : pickSurface(def.emittedBy);
      }
      if (def.blobs.includes("tier")) hot.tier = pickTier(def.emittedBy);
      for (const column of def.blobs) {
        if (column === "surface" || column === "tier") continue; // set above
        hot[column] = valueFor(column, def);
      }
      const values = {};
      for (const column of def.doubles) {
        values[column] = doubleFor(column, name);
      }

      let point;
      try {
        point = toAePoint(name, values, { ...attrs, ...hot });
      } catch (err) {
        throw new Error(`o11y-seed: toAePoint rejected a synthetic point for "${name}": ${err.message}`);
      }
      rows.push(pointToRow(point, timestampMs));
      if (rows.length >= 500) flush();
    }
  }
  flush();
  await Promise.all(chunks);
  return chunks.length;
}

// C-D3 (controller ruling on T09-D3): the real `/telemetry/deploy` body T02
// builds to, and this generator's annotation query must match — worker
// tenant, resource `service.name=demos-o11y`, `hot.surface=o11y`, body a
// JSON string `{"event":"deploy","service":…,"sha":…,"cf_version_id":…}`.
// This file's first draft invented `"actor":"ci"` instead; that field is
// gone now, matching the ruling exactly rather than a superset of it.
const DEPLOYABLE_SERVICES = ["handsontable-demos-api", "handsontable-demos-authoring", "handsontable-demos-o11y"];
function fakeCfVersionId() {
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

function deployAnnotationRecords() {
  // Runner overview's deploy annotations: a Loki `worker`-tenant log line
  // tagged `service_name=demos-o11y`, `hot_surface=o11y`, with a JSON body
  // carrying `event: "deploy"` — the shape C-D3 pins (above), which T02's
  // real `/telemetry/deploy` handler (not yet built) is told to match.
  // Spread across the last few minutes of `LOKI_RECENT_WINDOW_MS` (see its
  // comment) rather than the full window.
  const records = [];
  const stepMs = Math.max(60_000, Math.floor(LOKI_RECENT_WINDOW_MS / 5));
  for (let t = now; t > now - LOKI_RECENT_WINDOW_MS; t -= stepMs) {
    records.push(
      normalisedRecord({
        body: JSON.stringify({
          event: "deploy",
          service: pick(DEPLOYABLE_SERVICES),
          sha: hex(7),
          cf_version_id: fakeCfVersionId(),
        }),
        timestampMs: t,
        resourceAttrs: {
          "service.name": "demos-o11y",
          "service.version": hex(7),
          "deployment.environment.name": "local",
          "hot.surface": "o11y",
          "hot.tier": "none",
          "hot.framework": "none",
          "hot.ht_major": "none",
          "hot.outcome": "ready",
        },
        severityText: "INFO",
      }),
    );
  }
  return records;
}

function browserLogRecords() {
  // A representative sample of the log lines a real Faro exception/log item
  // would produce for the two surfaces the dashboards read raw text for:
  // demo-runtime (Tier-1 playground's runtime-error panel) and embed
  // (Docs embeds' error panel). AE already carries the counted/fingerprinted
  // side of these (preview.runtime_error, error.uncaught); these lines are
  // the text Loki alone holds (§1: "Loki holds the text").
  const records = [];
  const runtimeMessages = [
    "TypeError: Cannot read properties of undefined (reading 'render')",
    "ReferenceError: hot is not defined",
    "RangeError: Maximum call stack size exceeded",
  ];
  const embedMessages = [
    "TypeError: Failed to fetch",
    "NetworkError: the internet connection appears offline",
  ];
  for (let i = 0; i < 24; i++) {
    const framework = randomFramework();
    const htMajor = randomHtMajor();
    records.push(
      normalisedRecord({
        body: pick(runtimeMessages),
        timestampMs: randomRecentTimestamp(),
        resourceAttrs: {
          "service.name": "demos-authoring",
          "service.version": hex(7),
          "deployment.environment.name": "local",
          "hot.surface": "demo-runtime",
          "hot.tier": pick(["1", "2"]),
          "hot.framework": framework,
          "hot.ht_major": htMajor,
          "hot.outcome": "error",
        },
        attrs: { "hot.demo_id": pick(DEMO_IDS), "hot.kind": "exception" },
        severityText: "ERROR",
      }),
    );
  }
  for (let i = 0; i < 16; i++) {
    records.push(
      normalisedRecord({
        body: pick(embedMessages),
        timestampMs: randomRecentTimestamp(),
        resourceAttrs: {
          "service.name": "demos-authoring",
          "service.version": hex(7),
          "deployment.environment.name": "local",
          "hot.surface": "embed",
          "hot.tier": "static",
          "hot.framework": randomFramework(),
          "hot.ht_major": randomHtMajor(),
          "hot.outcome": "error",
        },
        attrs: { "hot.demo_id": pick(DEMO_IDS), "hot.kind": "exception" },
        severityText: "ERROR",
      }),
    );
  }
  return records;
}

function workerLogRecords() {
  // Observability-self's raw log-stream panel: a few lines resembling what
  // the o11y worker's own ingest/drain/wake cycle logs.
  const lines = [
    "o11y.ingest accepted reason=gate:ok",
    "o11y.drain ok reason=backlog objects=3",
    "o11y.wake reason=visit outcome=clean",
  ];
  const records = [];
  for (let i = 0; i < 18; i++) {
    records.push(
      normalisedRecord({
        body: pick(lines),
        timestampMs: randomRecentTimestamp(),
        resourceAttrs: {
          "service.name": "demos-o11y",
          "service.version": hex(7),
          "deployment.environment.name": "local",
          "hot.surface": "o11y",
          "hot.tier": "none",
          "hot.framework": "none",
          "hot.ht_major": "none",
          "hot.outcome": "ready",
        },
        severityText: "INFO",
      }),
    );
  }
  return records;
}

// ---- Main -----------------------------------------------------------------

async function main() {
  console.log(`o11y-seed: ClickHouse ${CH_URL}, Loki ${LOKI_URL}`);

  if (TRUNCATE_FIRST) {
    console.log(`o11y-seed: truncating ${TABLE} first (O11Y_SEED_TRUNCATE=0 to append instead)`);
    await chQuery(`TRUNCATE TABLE ${TABLE}`);
  }

  const batches = await seedAePoints();
  console.log(`o11y-seed: wrote AE points for ${METRIC_NAMES.length} metrics in ${batches} batch(es)`);

  // One push per tenant, every record for that tenant merged first: Loki
  // rejects an entry that lands behind the highest timestamp already
  // ingested for its exact label-set stream (measured live — see
  // `pushResourceLogs`'s comment). `deployAnnotationRecords` and
  // `workerLogRecords` both target the `service_name=demos-o11y,
  // hot_surface=o11y` stream, so pushing them in two separate calls (even
  // each internally sorted) can still regress that one shared stream's
  // high-water mark between calls. Merging first and sorting once removes
  // the seam entirely, for every stream, not just that one.
  const deployRecords = deployAnnotationRecords();
  const browserRecords = browserLogRecords();
  const workerRecords = [...deployRecords, ...workerLogRecords()];

  await pushResourceLogs("worker", workerRecords);
  await pushResourceLogs("browser", browserRecords);
  console.log(
    `o11y-seed: pushed ${workerRecords.length} worker-tenant log lines ` +
      `(${deployRecords.length} deploy annotations) and ${browserRecords.length} browser-tenant log lines`,
  );

  const countText = await chQuery(`SELECT count() FROM ${TABLE} FORMAT TabSeparated`);
  console.log(`o11y-seed: ${TABLE} now has ${countText.trim()} row(s)`);

  console.log("o11y-seed: done");
}

main().catch((err) => {
  console.error(`o11y-seed: FAILED — ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
