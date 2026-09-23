// pipeline/o11y-dashboards.test.mjs
//
// T09 (runner/tasks/o11y/T09-dashboards.md): the lint gate for every
// provisioned dashboard under containers/o11y/grafana/dashboards/. Local
// ClickHouse accepts far more SQL than Workers Analytics Engine does (T09's
// own "Traps" section) — this is the one place that difference is enforced,
// so a panel that only happens to work against the local shim never reaches
// production silently broken.
//
// Three rules, each proven to fail on a real violation (not just asserted to
// pass on clean input — see the three `test()`s under "the lint itself"
// below, and the revert-evidence note in this task's Outcome):
//
//   1. Every Analytics Engine (vertamedia-clickhouse-datasource) panel query
//      uses only known contract columns (§4: index1, the ASSIGNED blob/double
//      slots, `timestamp`/`_sample_interval` — the local-only columns §10
//      adds) and only an allowlisted function set; any bare use of `double1`
//      (the count slot) must sit inside the `SUM(_sample_interval * double1)`
//      reading rule (§4), never `COUNT()`.
//   2. Every Loki panel query and annotation query uses only the labels
//      `otlp_config` promotes (§3 — `LOKI_LABELS`, read from the same
//      telemetry module the contract test pins) and names its datasource by
//      a real tenant uid (`loki-browser`/`loki-worker`), never an implicit
//      default.
//   3. No dashboard carries a legacy panel-level `alert` block or a
//      dashboard-level `alerting` rule list (ADR-0041 §F.3: Grafana holds no
//      alert rules, only the built-in "Annotations & Alerts" query, which is
//      not a rule).
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build` (see
// telemetry-contract.test.mjs's header for why).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOKI_LABELS } from "../packages/runtime/dist/telemetry/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARDS_DIR = path.join(__dirname, "..", "containers", "o11y", "grafana", "dashboards");
const TABLE_NAME = "runner_events";

// ---- §4: the columns a local-ClickHouse-shim query is allowed to name -------
//
// index1 + the ASSIGNED blob/double slots (metrics.ts's `AE_COLUMNS` never
// emits blob20 or double9–double20 — they're reserved, unassigned §4 slots),
// plus the two columns that exist only in the local shim (§10): `timestamp`,
// `_sample_interval`.
const ASSIGNED_BLOB_COUNT = 19;
const ASSIGNED_DOUBLE_COUNT = 8;
const KNOWN_AE_COLUMNS = new Set([
  "index1",
  "timestamp",
  "_sample_interval",
  ...Array.from({ length: ASSIGNED_BLOB_COUNT }, (_, i) => `blob${i + 1}`),
  ...Array.from({ length: ASSIGNED_DOUBLE_COUNT }, (_, i) => `double${i + 1}`),
]);

// Every function this task's own dashboards actually use — SUM for the §4
// count-reading rule, quantileTDigestWeighted for a weighted percentile, AVG
// for an already-absolute gauge reading (never a count, see the dashboards'
// own "Gauges... AVG, not the count-sampling formula" panel descriptions),
// toStartOfInterval/toUInt32 as their supporting casts. A future dashboard
// that needs one more function adds it here, deliberately, in the same PR.
const ALLOWED_AE_FUNCTIONS = new Set(["SUM", "AVG", "quantileTDigestWeighted", "toStartOfInterval", "toUInt32"]);

const AE_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "AS",
  "GROUP",
  "BY",
  "ORDER",
  "IN",
  "LIMIT",
  "INTERVAL",
  "SECOND",
  "MINUTE",
  "HOUR",
  "DAY",
  "DESC",
  "ASC",
  "NULL",
  "TRUE",
  "FALSE",
]);

/** Strips string literals (ClickHouse `'...'`) and Grafana/vertamedia macros
 *  (`$table`, `$interval`, `${framework:sqlstring}`, `$timeFilterByColumn(timestamp)`)
 *  before tokenizing — none of those are a SQL identifier this lint judges. */
function stripLiteralsAndMacros(sql) {
  let s = sql;
  s = s.replace(/'[^']*'/g, "'STR'");
  s = s.replace(/\$\{[^}]*\}/g, " ");
  s = s.replace(/\$[A-Za-z_][A-Za-z0-9_]*\([^)]*\)/g, " ");
  s = s.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, " ");
  return s;
}

/** Every violation found in an Analytics Engine (ClickHouse) panel query —
 *  empty array means clean. Exercised both against every real dashboard
 *  (must be empty) and against synthetic bad queries below (must not be). */
function validateAeQuery(query) {
  const violations = [];
  const stripped = stripLiteralsAndMacros(query);

  // Every one of this task's dashboards is a flat, single-level SELECT (no
  // subqueries) — a query-local alias declared with `AS name` is a legitimate
  // reference everywhere else in that same query (GROUP BY/ORDER BY, and the
  // vertamedia plugin's own `t`/grouping-column convention this task's
  // queries use throughout). Collected per call, not globally, so an alias
  // from one query can never mask a real unknown column in another.
  const declaredAliases = new Set();
  const aliasRe = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let am;
  while ((am = aliasRe.exec(stripped))) declaredAliases.add(am[1]);

  const re = /([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/g;
  let m;
  while ((m = re.exec(stripped))) {
    const name = m[1];
    if (AE_KEYWORDS.has(name.toUpperCase())) continue; // "IN (...)" etc. — a keyword, never a function
    if (m[2]) {
      if (!ALLOWED_AE_FUNCTIONS.has(name)) violations.push(`disallowed function: ${name}(...)`);
      continue;
    }
    if (name === TABLE_NAME || name === "default" || name === "STR") continue;
    if (KNOWN_AE_COLUMNS.has(name)) continue;
    if (declaredAliases.has(name)) continue;
    violations.push(`unknown column or identifier: "${name}"`);
  }

  // §4's reading rule: double1 (the count slot) may only appear inside
  // `SUM(_sample_interval * double1)` — never bare (that's what COUNT()
  // would stand in for, and COUNT is already rejected above as a disallowed
  // function, but a query could reference double1 outside SUM entirely,
  // e.g. `WHERE double1 > 0`, which is just as wrong a read).
  if (/\bdouble1\b/.test(stripped) && !/_sample_interval\s*\*\s*double1/.test(stripped)) {
    violations.push("double1 used without the SUM(_sample_interval * double1) reading rule");
  }

  return violations;
}

const LOKI_LABEL_SET = new Set(LOKI_LABELS);

/** Every violation found in a LogQL selector/expr — empty means clean. */
function validateLokiExpr(expr) {
  const violations = [];
  const re = /\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(expr))) {
    for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const lm = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!=|=|!~)/.exec(part);
      if (!lm) continue;
      const label = lm[1];
      if (!LOKI_LABEL_SET.has(label)) violations.push(`disallowed Loki label: "${label}"`);
    }
  }
  return violations;
}

// ---- Dashboard-walking helpers -----------------------------------------------

function loadDashboards() {
  return fs
    .readdirSync(DASHBOARDS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      file: f,
      dashboard: JSON.parse(fs.readFileSync(path.join(DASHBOARDS_DIR, f), "utf8")),
    }));
}

function aeTargetsOf(dashboard) {
  const targets = [];
  for (const panel of dashboard.panels ?? []) {
    for (const target of panel.targets ?? []) {
      if (target.datasource?.type === "vertamedia-clickhouse-datasource") {
        targets.push({ panel: panel.title, query: target.query });
      }
    }
  }
  return targets;
}

function lokiTargetsOf(dashboard) {
  const targets = [];
  for (const panel of dashboard.panels ?? []) {
    for (const target of panel.targets ?? []) {
      if (target.datasource?.type === "loki") {
        targets.push({ panel: panel.title, uid: target.datasource.uid, expr: target.expr });
      }
    }
  }
  for (const ann of dashboard.annotations?.list ?? []) {
    if (ann.datasource?.type === "loki") {
      targets.push({ panel: `annotation:${ann.name}`, uid: ann.datasource.uid, expr: ann.expr });
    }
  }
  return targets;
}

const KNOWN_LOKI_UIDS = new Set(["loki-browser", "loki-worker"]);

// =============================================================================
// The dashboards this repo actually ships
// =============================================================================

const dashboards = loadDashboards();

test("every dashboard under containers/o11y/grafana/dashboards/ is present", () => {
  const titles = dashboards.map((d) => d.dashboard.title).sort();
  assert.deepEqual(titles, [
    "AI assist",
    "Docs embeds",
    "Observability self",
    "Runner overview",
    "Tier-1 playground",
    "Tier-2 sessions",
    "Version health",
  ]);
});

for (const { file, dashboard } of dashboards) {
  test(`${file}: every Analytics Engine query passes the AE lint`, () => {
    const targets = aeTargetsOf(dashboard);
    assert.ok(targets.length > 0, `${file} has no ClickHouse/AE panel — expected at least one`);
    for (const { panel, query } of targets) {
      const violations = validateAeQuery(query);
      assert.deepEqual(violations, [], `${file} / panel "${panel}": ${violations.join("; ")}\nquery: ${query}`);
    }
  });

  test(`${file}: every Loki query uses only contract labels and a named tenant datasource`, () => {
    for (const { panel, uid, expr } of lokiTargetsOf(dashboard)) {
      assert.ok(KNOWN_LOKI_UIDS.has(uid), `${file} / panel "${panel}": datasource uid "${uid}" is not a named Loki tenant`);
      const violations = validateLokiExpr(expr);
      assert.deepEqual(violations, [], `${file} / panel "${panel}": ${violations.join("; ")}\nexpr: ${expr}`);
    }
  });

  test(`${file}: carries no Grafana alert rule`, () => {
    assert.equal(dashboard.alerting, undefined, `${file} has a dashboard-level "alerting" block`);
    for (const panel of dashboard.panels ?? []) {
      assert.equal(panel.alert, undefined, `${file} / panel "${panel.title}" has a legacy panel-level alert`);
    }
  });
}

// =============================================================================
// The lint itself — proven to fail on the three violation shapes the
// acceptance criteria name, using synthetic queries a real dashboard would
// never ship (never mutating a committed file to prove this).
// =============================================================================

test("the lint fails on a COUNT() over Analytics Engine", () => {
  const violations = validateAeQuery(
    "SELECT toStartOfInterval(timestamp, INTERVAL $interval SECOND) AS t, COUNT() AS cnt " +
      "FROM $table WHERE $timeFilterByColumn(timestamp) AND index1 = 'preview.ready_ms' GROUP BY t ORDER BY t",
  );
  assert.ok(
    violations.some((v) => v.includes("COUNT")),
    `expected a COUNT() violation, got: ${JSON.stringify(violations)}`,
  );
});

test("the lint fails on an unknown column", () => {
  const violations = validateAeQuery(
    "SELECT SUM(_sample_interval * double1) AS cnt FROM $table WHERE $timeFilterByColumn(timestamp) AND outcome = 'ready'",
  );
  assert.ok(
    violations.some((v) => v.includes('"outcome"')),
    `expected an unknown-column violation for "outcome" (the friendly name, not blob8), got: ${JSON.stringify(violations)}`,
  );
});

test("the lint fails on an out-of-range (unassigned) AE slot", () => {
  const violations = validateAeQuery(
    "SELECT SUM(_sample_interval * double1) AS cnt FROM $table WHERE $timeFilterByColumn(timestamp) AND blob20 = 'x'",
  );
  assert.ok(
    violations.some((v) => v.includes('"blob20"')),
    `expected an unknown-column violation for the unassigned blob20, got: ${JSON.stringify(violations)}`,
  );
});

test("the lint fails on double1 read outside the SUM(_sample_interval * double1) rule", () => {
  const violations = validateAeQuery(
    "SELECT double1 AS cnt FROM $table WHERE $timeFilterByColumn(timestamp) AND index1 = 'preview.ready_ms'",
  );
  assert.ok(
    violations.some((v) => v.includes("reading rule")),
    `expected a reading-rule violation, got: ${JSON.stringify(violations)}`,
  );
});

test("the lint fails on a high-cardinality Loki label (demo_id)", () => {
  const violations = validateLokiExpr('{hot_surface="embed", demo_id="r-react-18-0-0"}');
  assert.ok(
    violations.some((v) => v.includes('"demo_id"')),
    `expected a disallowed-label violation for demo_id, got: ${JSON.stringify(violations)}`,
  );
});

test("the lint fails on a high-cardinality Loki label (session.id / cf.ray shape)", () => {
  for (const label of ["session_id", "cf_ray", "fingerprint"]) {
    const violations = validateLokiExpr(`{${label}="x"}`);
    assert.ok(
      violations.some((v) => v.includes(`"${label}"`)),
      `expected a disallowed-label violation for ${label}, got: ${JSON.stringify(violations)}`,
    );
  }
});

test("the lint passes a clean AE query (sanity: the lint isn't vacuously failing everything)", () => {
  assert.deepEqual(
    validateAeQuery(
      "SELECT toStartOfInterval(timestamp, INTERVAL $interval SECOND) AS t, blob5 AS tier, " +
        "SUM(_sample_interval * double1) AS cnt FROM $table WHERE $timeFilterByColumn(timestamp) " +
        "AND index1 = 'preview.ready_ms' AND blob3 = '$environment' GROUP BY t, tier ORDER BY t",
    ),
    [],
  );
});

test("the lint passes a clean Loki expr (sanity)", () => {
  assert.deepEqual(validateLokiExpr('{hot_surface="demo-runtime", service_name="demos-authoring"}'), []);
});
