// Lint gate for every provisioned dashboard: local ClickHouse accepts far more SQL than
// Workers Analytics Engine, so this is where that difference is enforced. Rules: AE queries
// use only §4 columns and allowlisted functions; Loki queries use only §3 labels and a named
// tenant; no alert blocks (ADR-0041 §F.3); a blobN filter is one its metric's §5 row sets;
// no dashboard ships a non-empty `refresh`. Each rule is proven failing in "the lint itself".
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOKI_LABELS, HT_MAJORS, ENVIRONMENTS, METRICS, AE_COLUMNS } from "../packages/runtime/dist/telemetry/index.js";
// One allowlist of Cloudflare's documented Analytics Engine SQL functions,
// shared with `workers/o11y/src/alerts/ae-query.ts` (the alert rules' own
// query helper) instead of two diverging copies — see that file's header
// for the doc pages/date this set was read from. A pure, import-free
// module, so no `o11y-worker-hooks.mjs` registration is needed to load it
// here.
const { ALLOWED_AE_FUNCTIONS, findUnsupportedAeConstructs } = await import("../workers/o11y/src/alerts/ae-query.ts");

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

// Cloudflare's documented Analytics Engine SQL API functions (read against
// developers.cloudflare.com/analytics/analytics-engine/sql-reference/
// {aggregate,date-time,type-conversion}-functions/, 2026-09-23) — never a
// wider "whatever local ClickHouse happens to accept" set, which is the
// whole point of this lint. Casing matches the docs' own signatures
// exactly: lowercase `sum`/`avg`, exact-case
// `quantileExactWeighted`/`toStartOfInterval`/`toUInt32` — a stray `SUM` or
// `COUNT` is rejected the same way an undocumented function would be.
// `quantileExactWeighted` is the documented weighted-percentile aggregate;
// `quantileTDigestWeighted` is a real ClickHouse function but does not
// appear on AE's aggregate-functions page.
//
// Imported from `alerts/ae-query.ts` above instead of a second literal Set
// here. That module's own set adds one function this task's dashboards
// never call (`now`) for the alert rules' time-window queries — a superset
// is safe for a lint that only rejects what a query actually uses.

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

  // Comparison inside arithmetic (`x * (blob8 = 'ready')`) is ClickHouse's
  // UInt8 trick; AE documents only sumIf/countIf/avgIf for a conditional sum.
  if (/[*+\-/]\s*\(\s*\w+\s*(?:=|!=|<>|<=|>=|<|>)\s*'STR'\s*\)/.test(stripped)) {
    violations.push("boolean arithmetic inside an aggregate (use sumIf)");
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

// ---- a panel may not filter on a blob its metric never sets ---------------

// Every point carries these three regardless of what its own §5 row lists
// (§4's "Analytics Engine layout" — `commonAttrs()` sets them unconditionally).
const UNIVERSAL_AE_COLUMNS = ["service_name", "service_version", "environment"];

/** The `blobN`/`doubleN` slots a metric's point can actually carry: its own §5
 *  "Blobs used" list plus the three universal columns, translated through
 *  `AE_COLUMNS` (the same column→slot map `toAePoint` itself writes through).
 *  `null` for a name `METRICS` doesn't know (never silently treated as "no
 *  columns allowed", which would flag every filter on an unrecognized/typo'd
 *  metric name instead of a real blob mismatch). */
function allowedSlotsForMetric(metricName) {
  const def = METRICS[metricName];
  if (!def) return null;
  const slots = new Set();
  for (const col of [...UNIVERSAL_AE_COLUMNS, ...def.blobs]) {
    const slot = AE_COLUMNS[col];
    if (slot) slots.add(slot);
  }
  return slots;
}

/** Metric names an AE query's WHERE clause names via `index1 = 'x'` or
 *  `index1 IN ('a', 'b')` — a query naming neither is read by some OTHER
 *  selector this rule does not understand yet, so it is skipped rather than
 *  flagged (this rule only ever adds violations for a shape it is sure of). */
function metricNamesFromWhere(whereClause) {
  const names = [];
  const eqRe = /index1\s*=\s*'([^']+)'/g;
  let m;
  while ((m = eqRe.exec(whereClause))) names.push(m[1]);
  const inRe = /index1\s+IN\s*\(([^)]*)\)/gi;
  while ((m = inRe.exec(whereClause))) {
    for (const part of m[1].split(",")) {
      const v = part.trim().replace(/^'|'$/g, "");
      if (v) names.push(v);
    }
  }
  return names;
}

/** Every `blobN` violation found in an AE query's WHERE clause — empty means
 *  clean. Scoped to WHERE only, so a SELECT-list expression like
 *  `sum(... * (blob8 = 'error'))` — a value computation, not a row filter —
 *  is never mistaken for a filter. A query whose WHERE names more than one
 *  metric (`index1 IN (...)`) requires a filtered blob to be one every
 *  named metric sets, since the filter applies to every row regardless of
 *  which metric produced it. */
function validateMetricBlobFilters(query) {
  const violations = [];
  const whereMatch = /\bWHERE\b([\s\S]*?)(\bGROUP\s+BY\b|\bORDER\s+BY\b|$)/i.exec(query);
  if (!whereMatch) return violations;
  const whereClause = whereMatch[1];
  const metricNames = metricNamesFromWhere(whereClause);
  if (metricNames.length === 0) return violations;
  const allowedSets = metricNames.map(allowedSlotsForMetric).filter((s) => s !== null);
  if (allowedSets.length === 0) return violations;
  const blobFilterRe = /\bblob(\d+)\s*(?:=|IN\s*\()/gi;
  const seen = new Set();
  let bm;
  while ((bm = blobFilterRe.exec(whereClause))) {
    const slot = `blob${bm[1]}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    if (!allowedSets.every((set) => set.has(slot))) {
      violations.push(`filters on ${slot}, which ${metricNames.join("/")} never sets (§5)`);
    }
  }
  return violations;
}

const LOKI_LABEL_SET = new Set(LOKI_LABELS);

/** Every violation found in a LogQL selector/expr — empty means clean. */
/** Strips `${varName}`/`${varName:format}` Grafana template-variable macros
 *  before the label scan below — mirroring `stripLiteralsAndMacros`'s own
 *  macro-stripping for AE queries. A `${service_name:regex}` value's own
 *  embedded `}` would otherwise fool `/\{([^}]*)\}/`'s non-greedy match
 *  into treating that macro's closing brace as the selector's closing
 *  brace, silently skipping every label listed after it. */
function stripLokiMacros(expr) {
  return expr.replace(/\$\{[^}]*\}/g, "MACRO");
}

function validateLokiExpr(expr) {
  const violations = [];
  const stripped = stripLokiMacros(expr);
  const re = /\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(stripped))) {
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

/** A non-empty `refresh` is a visit on every tick, which keeps
 *  `GrafanaBox`'s 15-min idle stop from ever firing while the tab is open.
 *  `null` means clean; a string names the offending value. The time
 *  picker's own refresh options stay in the dropdown regardless of this
 *  field, so a viewer can still turn refresh on for themselves. */
function validateNoAutoRefresh(dashboard) {
  if (dashboard.refresh) return `ships with "refresh": ${JSON.stringify(dashboard.refresh)}`;
  return null;
}

function loadDashboards() {
  return fs
    .readdirSync(DASHBOARDS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      file: f,
      dashboard: JSON.parse(fs.readFileSync(path.join(DASHBOARDS_DIR, f), "utf8")),
    }));
}

/** Every panel target's *effective* datasource — `target.datasource`,
 *  falling back to `panel.datasource` exactly the way Grafana itself
 *  resolves a target that doesn't repeat the panel's own datasource.
 *  Missing entirely — no target-level and no panel-level datasource, i.e.
 *  Grafana's implicit "default" datasource — is surfaced as
 *  `{ type: undefined, uid: undefined }`, never silently skipped: that is
 *  the "doesn't name its tenant" shape the Loki check must catch, and the
 *  AE check must not quietly pass over either. */
function allTargets(dashboard) {
  const targets = [];
  for (const panel of dashboard.panels ?? []) {
    for (const target of panel.targets ?? []) {
      const datasource = target.datasource ?? panel.datasource ?? {};
      targets.push({ panel: panel.title, target, datasource });
    }
  }
  return targets;
}

/** Template-variable queries (`dashboard.templating.list[]`) whose
 *  datasource is the ClickHouse plugin — `allTargets()` must also walk
 *  these, not just `panel.targets`, or a variable's own AE query (e.g.
 *  `environment`'s `SELECT DISTINCT blob3 FROM runner_events`) bypasses the
 *  lint entirely: a bad column or a disallowed function there would go
 *  straight to production undetected, same risk as a panel query. */
function templatingAeTargetsOf(dashboard) {
  return (dashboard.templating?.list ?? [])
    .filter((v) => v.datasource?.type === "vertamedia-clickhouse-datasource")
    .map((v) => ({ panel: `templating:${v.name}`, query: v.query }));
}

function aeTargetsOf(dashboard) {
  return [
    ...allTargets(dashboard)
      .filter(({ datasource }) => datasource.type === "vertamedia-clickhouse-datasource")
      .map(({ panel, target }) => ({ panel, query: target.query })),
    ...templatingAeTargetsOf(dashboard),
  ];
}

function lokiTargetsOf(dashboard) {
  const targets = allTargets(dashboard)
    .filter(({ datasource }) => datasource.type === "loki")
    .map(({ panel, target, datasource }) => ({ panel, uid: datasource.uid, expr: target.expr }));
  for (const ann of dashboard.annotations?.list ?? []) {
    if (ann.datasource?.type === "loki") {
      targets.push({ panel: `annotation:${ann.name}`, uid: ann.datasource.uid, expr: ann.expr });
    }
  }
  return targets;
}

const KNOWN_LOKI_UIDS = new Set(["loki-browser", "loki-worker"]);
const KNOWN_DATASOURCE_UIDS = new Set(["clickhouse-runner-events", "loki-browser", "loki-worker"]);

// ---- a panel/target may name its datasource by a template variable
// (`"${tenant}"`) instead of a literal uid — the Logs dashboard's `tenant`
// variable ("browser"/"worker") is how it lets a viewer pick which Loki
// tenant a panel queries. A bare allowlist entry for the literal string
// `"${tenant}"` would let any dashboard reference an undeclared variable
// and still pass; instead, a `${varName}` uid is only accepted when the
// same dashboard actually declares a template variable named `varName` of
// `type: "datasource"` — and, for the Loki-specific check, one scoped to
// the `loki` datasource type (`query: "loki"`), never the ClickHouse one. --

/** `${varName}` or `$varName` -> `varName`, else `null` (not a template ref). */
function templateVarRefName(uid) {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(uid ?? "");
  return m ? (m[1] ?? m[2]) : null;
}

/** Names of this dashboard's `type: "datasource"` template variables, optionally
 *  narrowed to ones whose `query` (the plugin type filter) matches `pluginQuery`. */
function templateDatasourceVarNames(dashboard, pluginQuery) {
  return new Set(
    (dashboard.templating?.list ?? [])
      .filter((v) => v.type === "datasource" && (pluginQuery === undefined || v.query === pluginQuery))
      .map((v) => v.name),
  );
}

/** Returns `null` when `uid` resolves to a known datasource — either a literal
 *  member of `knownUids`, or a `${varName}` reference to a `type:
 *  "datasource"` template variable this SAME dashboard declares (optionally
 *  scoped to `pluginQuery`, e.g. "loki") — otherwise a violation string. The
 *  ONE place this resolution logic lives: both the real per-dashboard checks
 *  below AND the synthetic tests exercise this exact function, so a synthetic
 *  test that breaks it is real revert evidence, not an assertion against a
 *  second, hand-duplicated copy of the same rule. */
function resolveDatasourceUid(dashboard, uid, knownUids, pluginQuery) {
  const varName = templateVarRefName(uid);
  if (varName !== null) {
    const datasourceVars = templateDatasourceVarNames(dashboard, pluginQuery);
    if (!datasourceVars.has(varName)) {
      return `datasource uid "${uid}" references an undeclared (or wrongly plugin-scoped) template variable "${varName}"`;
    }
    return null;
  }
  if (!knownUids.has(uid)) return `datasource uid "${JSON.stringify(uid)}" is not a known/named datasource`;
  return null;
}

// ---- what the vertamedia plugin + Grafana actually send to AE ---------------
//
// A local ClickHouse accepts SQL that Analytics Engine answers with a 422, so
// this mirrors the plugin's macro expansion (eval_query.go, v3.5.0) closely
// enough to lint the text AE really receives, not just the JSON template.

const SAMPLE_FROM = 1790663608;
const SAMPLE_TO = 1790685208;
const SAMPLE_INTERVAL_S = 20;

/** The value a custom `allValue` must have: Grafana does not quote or format it. */
const ALL_SENTINEL = "'__all__'";

function findVariable(dashboard, name) {
  return (dashboard.templating?.list ?? []).find((x) => x.name === name);
}

/** What `'$name'` expands to: the first option of a custom variable, or a
 *  stand-in for a query variable (filled from AE at runtime). */
function singleVariableValue(dashboard, name) {
  const v = findVariable(dashboard, name);
  if (!v) return { error: `no template variable "${name}" is declared` };
  if (v.type === "custom") return { value: (v.options ?? []).map((o) => o.value).find((x) => x !== "$__all") ?? "" };
  if (v.type === "query") return { value: "sample" };
  return { error: `variable "${name}" has unsupported type "${v.type}"` };
}

/** Every text a `${name:sqlstring}` reference can expand to, one per state the
 *  variable can be in when a panel runs: All, one value, several values, and a
 *  cleared selection, each for a populated option list and (query variables) a
 *  query that returned zero rows. Grafana quotes chosen values but not a
 *  custom `allValue`. A cleared multi-select is assumed to fall back to All
 *  when `includeAll` is on, and to expand to nothing otherwise. */
function variableExpansions(dashboard, name) {
  const v = findVariable(dashboard, name);
  if (!v) return { error: `no template variable "${name}" is declared` };
  if (v.type !== "custom" && v.type !== "query") return { error: `variable "${name}" has unsupported type "${v.type}"` };
  const quote = (xs) => xs.map((x) => `'${x}'`).join(",");
  const optionSets =
    v.type === "custom"
      ? [["options", (v.options ?? []).map((o) => o.value).filter((x) => x !== "$__all")]]
      : [["query rows", ["a", "b"]], ["zero query rows", []]];
  const states = [];
  for (const [label, options] of optionSets) {
    const all = v.allValue ?? quote(options);
    if (v.includeAll) states.push([`${label} / All`, all]);
    if (options.length > 0) states.push([`${label} / one value`, quote(options.slice(0, 1))]);
    if (options.length > 1 && v.multi) states.push([`${label} / several values`, quote(options.slice(0, 2))]);
    states.push([`${label} / cleared selection`, v.includeAll ? all : ""]);
  }
  return { states };
}

/** Expands the macros of `query` with `choice` (variable name -> the text its
 *  `${name:sqlstring}` becomes) and reports every problem in the result. */
function expandForAe(dashboard, query, choice = {}) {
  const problems = [];
  let sql = query;
  sql = sql.replace(/\$timeFilterByColumn\((\w+)\)/g, (_m, col) => `${col} >= toDateTime(${SAMPLE_FROM}) AND ${col} <= toDateTime(${SAMPLE_TO})`);
  sql = sql.replace(/\$interval\b/g, String(SAMPLE_INTERVAL_S));
  sql = sql.replace(/\$\{(\w+):sqlstring\}/g, (_m, name) => choice[name] ?? "?");
  sql = sql.replace(/'\$(\w+)'/g, (_m, name) => {
    const { value, error } = singleVariableValue(dashboard, name);
    if (error) {
      problems.push(error);
      return "'?'";
    }
    return `'${value}'`;
  });
  if (/\bIN\s*\(\s*\)/i.test(sql)) problems.push("empty IN () list");
  if (/(?<![!<>])=\s*''/.test(sql)) problems.push("comparison against an empty string");
  if (/\$/.test(sql)) problems.push(`unexpanded macro left in the query: ${sql.match(/\$[\w{(]*/)[0]}`);
  return { sql, problems };
}

/** A `${name:sqlstring}` reference is only allowed inside
 *  `('__all__' IN (${name:sqlstring}) OR col IN (${name:sqlstring}))`, with the
 *  variable's `allValue` set to the sentinel: All then means "no filter" and an
 *  empty option list can never reach AE as `IN ()`. */
const GUARDED_PREDICATE = /\('__all__' IN \(\$\{(\w+):sqlstring\}\) OR \w+ IN \(\$\{\1:sqlstring\}\)\)/g;

function variableGuardProblems(dashboard, query) {
  const problems = [];
  const names = [...new Set([...query.matchAll(/\$\{(\w+):sqlstring\}/g)].map((m) => m[1]))];
  if (query.replace(GUARDED_PREDICATE, "").match(/\$\{\w+:sqlstring\}/)) {
    problems.push("a ${var:sqlstring} predicate is not wrapped as ('__all__' IN (${var:sqlstring}) OR col IN (${var:sqlstring}))");
  }
  for (const name of names) {
    const v = findVariable(dashboard, name);
    if (v && v.allValue !== ALL_SENTINEL) problems.push(`variable "${name}" must set allValue to ${ALL_SENTINEL}`);
  }
  return { problems, names };
}

/** Every Analytics-Engine-surface violation of one query: the template text
 *  itself, then the SQL that results from every combination of states the
 *  referenced variables can be in. */
function validateAeSurface(dashboard, query) {
  const { problems: guardProblems, names } = variableGuardProblems(dashboard, query);
  const violations = [...guardProblems];
  let combos = [{ label: "", choice: {} }];
  for (const name of names) {
    const { states, error } = variableExpansions(dashboard, name);
    if (error) {
      violations.push(error);
      continue;
    }
    combos = combos.flatMap((c) =>
      states.map(([label, text]) => ({ label: `${c.label}${c.label ? ", " : ""}${name}: ${label}`, choice: { ...c.choice, [name]: text } })),
    );
  }
  for (const { label, choice } of combos) {
    const { problems } = expandForAe(dashboard, query, choice);
    for (const p of problems) violations.push(label ? `${p} [${label}]` : p);
  }
  const { sql } = expandForAe(dashboard, query, Object.fromEntries(names.map((n) => [n, "'x'"])));
  return [
    ...new Set(violations),
    ...new Set([...findUnsupportedAeConstructs(query), ...findUnsupportedAeConstructs(sql)]),
    ...(/\bFORMAT\b/i.test(query) ? ["query names FORMAT (the plugin appends FORMAT JSON itself)"] : []),
    ...(/FROM\s+runner_events\b/.test(sql) ? [] : ["must read FROM the bare dataset name runner_events"]),
  ];
}

// =============================================================================
// The dashboards this repo actually ships
// =============================================================================

const dashboards = loadDashboards();

test("every dashboard under containers/o11y/grafana/dashboards/ is present", () => {
  const titles = dashboards.map((d) => d.dashboard.title).sort();
  assert.deepEqual(titles, [
    "AI assist",
    "Docs embeds",
    "Examples & features",
    "Logs",
    "Observability self",
    "Runner overview",
    "Tier-1 playground",
    "Tier-2 sessions",
    "Version health",
  ]);
});

for (const { file, dashboard } of dashboards) {
  test(`${file}: every panel target resolves (with the panel-level fallback) to a known datasource uid`, () => {
    // Closes the gap a target-only check would miss: a target that omits its
    // own `datasource` and relies on the panel's (a shape Grafana itself
    // resolves the same way) must still land on one of the three
    // uids this box provisions, never on an implicit/unnamed default —
    // exactly the "names its tenant datasource" rule, generalized to every
    // target, not only ones that happen to already say `type: "loki"`.
    for (const { panel, datasource } of allTargets(dashboard)) {
      const violation = resolveDatasourceUid(dashboard, datasource.uid, KNOWN_DATASOURCE_UIDS);
      assert.equal(violation, null, `${file} / panel "${panel}": ${violation}`);
    }
  });

  test(`${file}: ht_major variable options equal the contract's HT_MAJORS (attrs.ts), not a hand-duplicated copy`, () => {
    // "15,16,17,18,19,next,none" + one options entry per value was
    // hand-typed into all 7 dashboards. This pins every dashboard's copy
    // against the one real source (HT_MAJORS), so a future contract change
    // (§3 is append-only, but a new major still lands here) is a failing
    // test in 7 places instead of a silent drift in some of them.
    const htMajorVar = dashboard.templating.list.find((v) => v.name === "ht_major");
    assert.ok(htMajorVar, `${file} has no "ht_major" template variable`);
    const optionValues = htMajorVar.options.map((o) => o.value).filter((v) => v !== "$__all");
    assert.deepEqual(optionValues, [...HT_MAJORS]);
  });

  test(`${file}: every Analytics Engine query passes the AE lint`, () => {
    const targets = aeTargetsOf(dashboard);
    assert.ok(targets.length > 0, `${file} has no ClickHouse/AE panel — expected at least one`);
    for (const { panel, query } of targets) {
      const violations = validateAeQuery(query);
      assert.deepEqual(violations, [], `${file} / panel "${panel}": ${violations.join("; ")}\nquery: ${query}`);
    }
  });

  test(`${file}: no Analytics Engine query filters on a blob its metric(s) never set`, () => {
    for (const { panel, query } of aeTargetsOf(dashboard)) {
      const violations = validateMetricBlobFilters(query);
      assert.deepEqual(violations, [], `${file} / panel "${panel}": ${violations.join("; ")}\nquery: ${query}`);
    }
  });

  test(`${file}: every Analytics Engine query is safe as AE receives it (no DISTINCT/$table/empty IN (), macros expanded)`, () => {
    for (const { panel, query } of aeTargetsOf(dashboard)) {
      const violations = validateAeSurface(dashboard, query);
      assert.deepEqual(violations, [], `${file} / panel "${panel}": ${violations.join("; ")}\nquery: ${query}`);
    }
  });

  // add_metadata makes the plugin prepend a comment to the query; whether AE
  // accepts that is unverified, so the dashboards keep it off.
  test(`${file}: no ClickHouse target enables the plugin's metadata comment`, () => {
    for (const { panel, target } of allTargets(dashboard)) {
      assert.notEqual(target.add_metadata, true, `${file} / panel "${panel}" sets add_metadata`);
    }
  });

  test(`${file}: the environment variable is pinned to the contract's ENVIRONMENTS`, () => {
    const envVar = dashboard.templating.list.find((v) => v.name === "environment");
    assert.ok(envVar, `${file} has no "environment" template variable`);
    assert.equal(envVar.type, "custom", "a query variable would go through AE and can come back empty");
    assert.deepEqual(envVar.options.map((o) => o.value), [...ENVIRONMENTS]);
    // Grafana rebuilds a custom variable's options from `query`, not from `options`.
    assert.equal(envVar.query, ENVIRONMENTS.join(","));
    assert.equal(envVar.current.value, "production");
  });

  test(`${file}: every Loki query uses only contract labels and a named tenant datasource`, () => {
    for (const { panel, uid, expr } of lokiTargetsOf(dashboard)) {
      const violation = resolveDatasourceUid(dashboard, uid, KNOWN_LOKI_UIDS, "loki");
      assert.equal(violation, null, `${file} / panel "${panel}": ${violation}`);
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

  test(`${file}: ships with auto-refresh off ("refresh": "")`, () => {
    assert.equal(validateNoAutoRefresh(dashboard), null, `${file}: ${validateNoAutoRefresh(dashboard)}`);
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

test("the lint fails on a disallowed label placed AFTER a ${var:regex} macro in the same selector (the macro's own closing brace was fooling the non-greedy {...} match)", () => {
  const violations = validateLokiExpr('{service_name=~"${service_name:regex}", session_id="x"}');
  assert.ok(
    violations.some((v) => v.includes('"session_id"')),
    `expected a disallowed-label violation for session_id after the macro, got: ${JSON.stringify(violations)}`,
  );
});

test("the lint fails on a bad templating-variable AE query (variable queries were invisible to aeTargetsOf)", () => {
  const dashboard = {
    templating: {
      list: [
        {
          name: "environment",
          datasource: { type: "vertamedia-clickhouse-datasource", uid: "clickhouse-runner-events" },
          query: "SELECT DISTINCT outcome FROM runner_events", // "outcome" is the friendly name, not blob8
        },
      ],
    },
    panels: [],
  };
  const targets = aeTargetsOf(dashboard);
  assert.equal(targets.length, 1, "expected the templating-variable query to be picked up");
  const violations = validateAeQuery(targets[0].query);
  assert.ok(
    violations.some((v) => v.includes('"outcome"')),
    `expected an unknown-column violation for "outcome", got: ${JSON.stringify(violations)}`,
  );
});

test("the blob-filter lint fails on bucket.resolve_ms's OLD query shape (blob6/blob7, which its §5 row never lists)", () => {
  const violations = validateMetricBlobFilters(
    "SELECT toStartOfInterval(timestamp, INTERVAL '$interval' SECOND) AS t, blob16 AS bucket, " +
      "quantileExactWeighted(0.95)(double2, toUInt32(_sample_interval)) AS p95 FROM $table " +
      "WHERE $timeFilterByColumn(timestamp) AND index1 = 'bucket.resolve_ms' AND blob3 = '$environment' " +
      "AND blob6 IN (${framework:sqlstring}) AND blob7 IN (${ht_major:sqlstring}) GROUP BY t, bucket ORDER BY t",
  );
  assert.ok(violations.some((v) => v.includes("blob6")), `expected a blob6 violation, got: ${JSON.stringify(violations)}`);
  assert.ok(violations.some((v) => v.includes("blob7")), `expected a blob7 violation, got: ${JSON.stringify(violations)}`);
});

test("the blob-filter lint passes bucket.resolve_ms's fixed query shape (bucket/outcome/environment only)", () => {
  assert.deepEqual(
    validateMetricBlobFilters(
      "SELECT toStartOfInterval(timestamp, INTERVAL '$interval' SECOND) AS t, blob16 AS bucket, " +
        "quantileExactWeighted(0.95)(double2, toUInt32(_sample_interval)) AS p95 FROM $table " +
        "WHERE $timeFilterByColumn(timestamp) AND index1 = 'bucket.resolve_ms' AND blob3 = '$environment' " +
        "GROUP BY t, bucket ORDER BY t",
    ),
    [],
  );
});

test("the blob-filter lint ignores a blob8 comparison inside a SELECT-list value expression, not a WHERE filter (the error-rate panel's own shape)", () => {
  assert.deepEqual(
    validateMetricBlobFilters(
      "SELECT toStartOfInterval(timestamp, INTERVAL '$interval' SECOND) AS t, blob16 AS bucket, " +
        "100 * sum(_sample_interval * double1 * (blob8 = 'error')) / sum(_sample_interval * double1) AS pct " +
        "FROM $table WHERE $timeFilterByColumn(timestamp) AND index1 = 'bucket.resolve_ms' " +
        "AND blob3 = '$environment' GROUP BY t, bucket ORDER BY t",
    ),
    [],
  );
});

test("the blob-filter lint requires a multi-metric (index1 IN (...)) query's blob filter to be set by EVERY named metric", () => {
  // sandpack.compile_ms sets blob6 (framework); o11y.wake does not — a shared
  // blob6 filter across both would silently drop every o11y.wake row.
  const violations = validateMetricBlobFilters(
    "SELECT count() FROM $table WHERE index1 IN ('sandpack.compile_ms', 'o11y.wake') AND blob6 = 'react'",
  );
  assert.ok(
    violations.some((v) => v.includes("blob6")),
    `expected a blob6 violation, got: ${JSON.stringify(violations)}`,
  );
});

test("the blob-filter lint on the REAL tier1-playground.json dashboard (revert evidence: putting blob6/blob7 back into either bucket.resolve_ms panel's query must break this)", () => {
  const { dashboard } = dashboards.find((d) => d.file === "tier1-playground.json");
  assert.ok(dashboard, "tier1-playground.json must exist and be loaded");
  const targets = aeTargetsOf(dashboard).filter(({ query }) => query.includes("'bucket.resolve_ms'"));
  assert.equal(targets.length, 2, "expected exactly the two bucket.resolve_ms panels");
  for (const { panel, query } of targets) {
    assert.deepEqual(validateMetricBlobFilters(query), [], `panel "${panel}"`);
  }
});

test("the lint fails on a dashboard shipping a non-empty refresh", () => {
  for (const refresh of ["1m", "5m", "30s"]) {
    const violation = validateNoAutoRefresh({ refresh });
    assert.ok(violation && violation.includes(refresh), `expected a violation naming "${refresh}", got: ${violation}`);
  }
});

test("the lint passes a dashboard with refresh off", () => {
  assert.equal(validateNoAutoRefresh({ refresh: "" }), null);
});

test("the lint passes a clean AE query (sanity: the lint isn't vacuously failing everything)", () => {
  assert.deepEqual(
    validateAeQuery(
      "SELECT toStartOfInterval(timestamp, INTERVAL '$interval' SECOND) AS t, blob5 AS tier, " +
        "sum(_sample_interval * double1) AS cnt FROM $table WHERE $timeFilterByColumn(timestamp) " +
        "AND index1 = 'preview.ready_ms' AND blob3 = '$environment' GROUP BY t, tier ORDER BY t",
    ),
    [],
  );
});

test("the lint passes a clean Loki expr (sanity)", () => {
  assert.deepEqual(validateLokiExpr('{hot_surface="demo-runtime", service_name="demos-authoring"}'), []);
});

test("the datasource check fails on a target with no datasource at all (target-only check would miss this)", () => {
  const dashboard = {
    panels: [
      {
        title: "No datasource anywhere",
        // No panel-level datasource either — this is Grafana's implicit
        // "default" datasource, which a target-only scan (this file's first
        // draft) silently skipped instead of flagging.
        targets: [{ refId: "A", expr: '{hot_surface="o11y"}' }],
      },
    ],
  };
  const resolved = allTargets(dashboard);
  assert.equal(resolved.length, 1);
  assert.ok(
    !KNOWN_DATASOURCE_UIDS.has(resolved[0].datasource.uid),
    "expected the unnamed-datasource target to NOT resolve to a known uid",
  );
});

test("the datasource check accepts a target that only names its datasource at the panel level", () => {
  const dashboard = {
    panels: [
      {
        title: "Panel-level datasource, target omits it",
        datasource: { type: "loki", uid: "loki-worker" },
        targets: [{ refId: "A", expr: '{hot_surface="o11y"}' }],
      },
    ],
  };
  const resolved = allTargets(dashboard);
  assert.equal(resolved[0].datasource.uid, "loki-worker");
});

// ---- the `${varName}` template-datasource-reference lint ------------------

test('templateVarRefName: recognizes "${tenant}" and "$tenant", rejects a literal uid', () => {
  assert.equal(templateVarRefName("${tenant}"), "tenant");
  assert.equal(templateVarRefName("$tenant"), "tenant");
  assert.equal(templateVarRefName("loki-worker"), null);
});

test("resolveDatasourceUid rejects a ${var} reference to an UNDECLARED template variable — calling the SAME function the real per-dashboard checks call", () => {
  const dashboard = { templating: { list: [] } }; // no "tenant" datasource variable declared
  const violation = resolveDatasourceUid(dashboard, "${tenant}", KNOWN_DATASOURCE_UIDS);
  assert.ok(violation && violation.includes('"tenant"'), `expected a violation naming "tenant", got: ${violation}`);
});

test("resolveDatasourceUid accepts a declared `type: \"datasource\"` template variable's uid reference, scoped to the right plugin", () => {
  const dashboard = { templating: { list: [{ name: "tenant", type: "datasource", query: "loki" }] } };
  assert.equal(resolveDatasourceUid(dashboard, "${tenant}", KNOWN_DATASOURCE_UIDS), null);
  assert.equal(resolveDatasourceUid(dashboard, "${tenant}", KNOWN_LOKI_UIDS, "loki"), null);
  // A "tenant" variable scoped to a DIFFERENT plugin (e.g. the ClickHouse
  // one) must not satisfy the Loki-specific check — never widen past what
  // the dashboard actually declared.
  const chDashboard = { templating: { list: [{ name: "tenant", type: "datasource", query: "vertamedia-clickhouse-datasource" }] } };
  assert.notEqual(resolveDatasourceUid(chDashboard, "${tenant}", KNOWN_LOKI_UIDS, "loki"), null);
});

test("logs.json: the tenant-templated datasource resolves via resolveDatasourceUid on the REAL dashboard (revert evidence: removing the ${var} branch from resolveDatasourceUid must break this)", () => {
  const { dashboard } = dashboards.find((d) => d.file === "logs.json");
  assert.ok(dashboard, "logs.json must exist and be loaded");
  assert.ok(
    templateDatasourceVarNames(dashboard).has("tenant"),
    'logs.json must declare a "tenant" datasource-type variable',
  );
  for (const { panel, datasource } of allTargets(dashboard)) {
    const violation = resolveDatasourceUid(dashboard, datasource.uid, KNOWN_DATASOURCE_UIDS);
    assert.equal(violation, null, `panel "${panel}": ${violation}`);
  }
});

// ---- the AE-surface lint fails on the shapes that broke production --------------

test("the AE-surface lint fails on the captured production query (default.runner_events, empty IN (), blob3 = '')", () => {
  const dashboard = { templating: { list: [{ name: "framework", type: "query" }] } };
  const captured =
    "SELECT toStartOfInterval(timestamp, INTERVAL '20' SECOND) AS t, blob5 AS tier FROM default.runner_events " +
    "WHERE timestamp >= toDateTime(1790663608) AND blob3 = '' AND blob6 IN () GROUP BY t, tier ORDER BY t";
  const violations = validateAeSurface(dashboard, captured);
  assert.ok(violations.some((v) => v.includes("schema-qualified")), JSON.stringify(violations));
  assert.ok(violations.some((v) => v.includes("empty IN ()")), JSON.stringify(violations));
  assert.ok(violations.some((v) => v.includes("empty string")), JSON.stringify(violations));
});

test("the AE-surface lint fails on SELECT DISTINCT and $table", () => {
  const dashboard = { templating: { list: [] } };
  const distinct = validateAeSurface(dashboard, "SELECT DISTINCT blob3 AS environment FROM runner_events");
  assert.ok(distinct.some((v) => v.includes("SELECT DISTINCT")), JSON.stringify(distinct));
  const table = validateAeSurface(dashboard, "SELECT sum(_sample_interval * double1) AS c FROM $table WHERE $timeFilterByColumn(timestamp)");
  assert.ok(table.some((v) => v.includes("$table")), JSON.stringify(table));
});

// A `framework` variable whose query returns zero rows (production today: no
// event carries a framework yet) must not leave `IN ()` in the SQL AE receives.
const FRAMEWORK_QUERY_VARIABLE = { name: "framework", type: "query", multi: true, includeAll: true };
const FRAMEWORK_QUERY = "SELECT sum(_sample_interval * double1) AS c FROM runner_events WHERE $timeFilterByColumn(timestamp) AND ";
const BARE_FRAMEWORK_PREDICATE = "blob6 IN (${framework:sqlstring})";
const GUARDED_FRAMEWORK_PREDICATE = "('__all__' IN (${framework:sqlstring}) OR blob6 IN (${framework:sqlstring}))";

test("the AE-surface lint fails a bare ${var:sqlstring} predicate on a variable that can be empty", () => {
  const dashboard = { templating: { list: [FRAMEWORK_QUERY_VARIABLE] } };
  const violations = validateAeSurface(dashboard, FRAMEWORK_QUERY + BARE_FRAMEWORK_PREDICATE);
  assert.ok(violations.some((v) => v.includes("not wrapped")), JSON.stringify(violations));
  assert.ok(violations.some((v) => v.includes("empty IN () list") && v.includes("zero query rows / All")), JSON.stringify(violations));
});

test("the AE-surface lint fails the guarded predicate when the variable lacks allValue, and passes it with allValue for a zero-row variable", () => {
  const withoutAllValue = validateAeSurface({ templating: { list: [FRAMEWORK_QUERY_VARIABLE] } }, FRAMEWORK_QUERY + GUARDED_FRAMEWORK_PREDICATE);
  assert.ok(withoutAllValue.some((v) => v.includes("must set allValue")), JSON.stringify(withoutAllValue));
  assert.ok(withoutAllValue.some((v) => v.includes("empty IN () list")), JSON.stringify(withoutAllValue));

  const withAllValue = { templating: { list: [{ ...FRAMEWORK_QUERY_VARIABLE, allValue: "'__all__'" }] } };
  assert.deepEqual(validateAeSurface(withAllValue, FRAMEWORK_QUERY + GUARDED_FRAMEWORK_PREDICATE), []);
});

test("the AE-surface lint models All, one value, several values and a cleared selection, and fails an empty list in any of them", () => {
  const guarded = { ...FRAMEWORK_QUERY_VARIABLE, allValue: "'__all__'" };
  const { states } = variableExpansions({ templating: { list: [guarded] } }, "framework");
  assert.deepEqual(Object.fromEntries(states), {
    "query rows / All": "'__all__'",
    "query rows / one value": "'a'",
    "query rows / several values": "'a','b'",
    "query rows / cleared selection": "'__all__'",
    "zero query rows / All": "'__all__'",
    "zero query rows / cleared selection": "'__all__'",
  });
  // Without includeAll a cleared selection has nothing to fall back to.
  const noAll = variableExpansions({ templating: { list: [{ ...guarded, includeAll: false }] } }, "framework").states;
  assert.equal(Object.fromEntries(noAll)["query rows / cleared selection"], "");
  const violations = validateAeSurface({ templating: { list: [{ ...guarded, includeAll: false }] } }, FRAMEWORK_QUERY + GUARDED_FRAMEWORK_PREDICATE);
  assert.ok(violations.some((v) => v.includes("empty IN () list") && v.includes("cleared selection")), JSON.stringify(violations));
});

test("every shipped multi-value variable that reaches an AE predicate sets allValue to the sentinel", () => {
  for (const { file, dashboard } of dashboards) {
    const used = new Set();
    for (const { query } of aeTargetsOf(dashboard)) for (const m of query.matchAll(/\$\{(\w+):sqlstring\}/g)) used.add(m[1]);
    for (const name of used) {
      const v = dashboard.templating.list.find((x) => x.name === name);
      assert.equal(v?.allValue, ALL_SENTINEL, `${file}: variable "${name}" must set allValue`);
    }
  }
});

test("the AE-surface lint fails on a reference to an undeclared variable, and passes the fixed shape", () => {
  const dashboard = {
    templating: {
      list: [{ name: "ht_major", type: "custom", multi: true, includeAll: true, allValue: "'__all__'", options: [{ value: "$__all" }, { value: "18" }] }],
    },
  };
  const undeclared = validateAeSurface(dashboard, "SELECT sum(_sample_interval * double1) AS c FROM runner_events WHERE blob3 = '$environment'");
  assert.ok(undeclared.some((v) => v.includes('"environment"')), JSON.stringify(undeclared));
  assert.deepEqual(
    validateAeSurface(
      dashboard,
      "SELECT toStartOfInterval(timestamp, INTERVAL '$interval' SECOND) AS t, 100 * sumIf(_sample_interval * double1, blob8 = 'ready') / sum(_sample_interval * double1) AS pct " +
        "FROM runner_events WHERE $timeFilterByColumn(timestamp) AND index1 = 'preview.ready_ms' AND ('__all__' IN (${ht_major:sqlstring}) OR blob7 IN (${ht_major:sqlstring})) GROUP BY t ORDER BY t",
    ),
    [],
  );
});

test("the epoch-millisecond time column fallback passes the AE guard (allowlisted functions only)", () => {
  const dashboard = { templating: { list: [] } };
  assert.deepEqual(
    validateAeSurface(
      dashboard,
      "SELECT toUInt32(toStartOfInterval(timestamp, INTERVAL '$interval' SECOND)) * 1000 AS t, blob9 AS route, sum(_sample_interval * double1) AS n " +
        "FROM runner_events WHERE $timeFilterByColumn(timestamp) AND index1 = 'x' GROUP BY t, route ORDER BY t",
    ),
    [],
  );
});

test("the AE lint fails on boolean arithmetic inside sum() (undocumented; use sumIf)", () => {
  const violations = validateAeQuery(
    "SELECT sum(_sample_interval * double1 * (blob8 = 'ready')) AS c FROM runner_events WHERE $timeFilterByColumn(timestamp)",
  );
  assert.ok(violations.some((v) => v.includes("boolean")), JSON.stringify(violations));
});

// =============================================================================
// Metrics emitted but unread by any dashboard. Each assertion below fails
// if the corresponding panel is removed.
// =============================================================================

test("budget.gauge, bucket.resolve_ms, example.forked and example.downloaded are each read by SOME dashboard's AE query", () => {
  const allAeQueries = dashboards.flatMap(({ dashboard }) => aeTargetsOf(dashboard).map((t) => t.query));
  for (const metric of ["budget.gauge", "bucket.resolve_ms", "example.forked", "example.downloaded"]) {
    assert.ok(
      allAeQueries.some((q) => q.includes(`'${metric}'`)),
      `no dashboard's AE query references index1 = '${metric}' — this metric is emitted but unread`,
    );
  }
});

test("logs.json: has the Sentry issues panel (|= \"sentry \" line filter) and the top-fingerprints table (blob11)", () => {
  const { dashboard } = dashboards.find((d) => d.file === "logs.json");
  const lokiExprs = lokiTargetsOf(dashboard).map((t) => t.expr);
  assert.ok(
    lokiExprs.some((e) => e.includes('|= "sentry "')),
    "logs.json has no panel filtering worker-tenant lines for the Sentry webhook's own body shape",
  );
  const aeQueries = aeTargetsOf(dashboard).map((t) => t.query);
  assert.ok(
    aeQueries.some((q) => q.includes("blob11")),
    "logs.json has no AE panel reading blob11 (fingerprint) — the top-error-fingerprints table",
  );
});

test("runner-overview.json and observability-self.json each link to the Logs dashboard", () => {
  for (const file of ["runner-overview.json", "observability-self.json"]) {
    const { dashboard } = dashboards.find((d) => d.file === file);
    const links = dashboard.links ?? [];
    assert.ok(
      links.some((l) => l.url === "/d/o11y-logs/logs"),
      `${file} has no dashboard link to /d/o11y-logs/logs`,
    );
  }
});

test("observability-self.json has an o11y.ingest dropped-by-reason panel that filters on outcome dropped and groups by reason", () => {
  const { dashboard } = dashboards.find((d) => d.file === "observability-self.json");
  const panel = dashboard.panels.find((p) => p.title === "o11y.ingest dropped by reason");
  assert.ok(panel, "observability-self.json has no 'o11y.ingest dropped by reason' panel");
  const query = panel.targets[0].query;
  assert.match(query, /index1 = 'o11y\.ingest'/);
  assert.match(query, /blob8 = 'dropped'/);
  assert.match(query, /blob9 AS reason/);
  assert.match(query, /GROUP BY t, reason/);
});
