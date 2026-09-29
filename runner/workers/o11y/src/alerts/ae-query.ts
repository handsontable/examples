// The query helper ADR-0041 §F.3's alert rules read Analytics Engine
// through — one allowlisted helper for Analytics Engine's documented SQL
// functions, reused by the dashboard lint. Read from Cloudflare's
// documented SQL API surface (aggregate/date-time functions) on
// 2026-09-23. Never widened to "whatever local ClickHouse accepts."
export const ALLOWED_AE_FUNCTIONS: ReadonlySet<string> = new Set([
  "sum",
  "sumIf",
  "avg",
  "quantileExactWeighted",
  "toStartOfInterval",
  "toUInt32",
  "toDateTime",
  "now",
]);

/** SQL keywords this module's own queries use — never a function call, and
 *  never flagged by {@link findDisallowedAeFunctions}. */
const AE_KEYWORDS: ReadonlySet<string> = new Set([
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

/** Strips string literals before scanning for function-call identifiers —
 *  this module's own queries carry no Grafana macros, so only the literal-
 *  stripping half of that pattern is needed here. */
function stripLiterals(sql: string): string {
  return sql.replace(/'[^']*'/g, "'STR'");
}

/** Every disallowed function call found in `sql` — empty means clean. A
 *  bare identifier not followed by `(` is never flagged: this module's
 *  queries are hand-built, not user-editable dashboard JSON. */
export function findDisallowedAeFunctions(sql: string): string[] {
  const stripped = stripLiterals(sql);
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const violations: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const name = m[1] as string;
    if (AE_KEYWORDS.has(name.toUpperCase())) continue; // e.g. "IN (...)"
    if (!ALLOWED_AE_FUNCTIONS.has(name)) violations.push(name);
  }
  return violations;
}

/** SQL shapes Analytics Engine rejects (or, for a schema-qualified table,
 *  is not documented to accept) but local ClickHouse runs happily. Scanned on
 *  the literal-stripped text, so a `'union'` string never trips it. Grafana
 *  macros are left in place: `$table` expands to `default.runner_events`. */
const UNSUPPORTED_AE_CONSTRUCTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bSELECT\s+DISTINCT\b/i, "SELECT DISTINCT (use GROUP BY)"],
  [/\b(?:INNER|LEFT|RIGHT|FULL|CROSS|OUTER|ARRAY)?\s*JOIN\b/i, "JOIN"],
  [/\bUNION\b/i, "UNION"],
  [/^\s*WITH\b/i, "WITH (CTE)"],
  [/\bFROM\s*\(/i, "subquery in FROM"],
  [/\(\s*SELECT\b/i, "subquery"],
  [/\bOVER\s*\(/i, "window function"],
  [/\$table\b/, "$table (the plugin expands it to `default.runner_events`)"],
  [/\bFROM\s+[A-Za-z_][A-Za-z0-9_]*\./i, "schema-qualified table name"],
];

/** Every unsupported construct found in `sql` — empty means clean. */
export function findUnsupportedAeConstructs(sql: string): string[] {
  const stripped = stripLiterals(sql);
  return UNSUPPORTED_AE_CONSTRUCTS.filter(([re]) => re.test(stripped)).map(([, label]) => label);
}

export function assertAllowedAeQuery(sql: string): void {
  const unsupported = findUnsupportedAeConstructs(sql);
  if (unsupported.length > 0) {
    throw new Error(`ae-query: unsupported construct(s) in query: ${unsupported.join(", ")}`);
  }
  const disallowed = findDisallowedAeFunctions(sql);
  if (disallowed.length > 0) {
    throw new Error(`ae-query: disallowed function(s) in query: ${disallowed.join(", ")}`);
  }
}

export interface AeQueryEnv {
  O11Y_ENV: "production" | "local";
  CLOUDFLARE_ACCOUNT_ID: string;
  AE_SQL_TOKEN?: string;
  RUNNER_EVENTS_CLICKHOUSE_URL?: string;
}

export type AeRow = Record<string, string | number>;

/**
 * Runs `sql` and returns its rows. Refuses (throws, never silently drops)
 * any query naming a function outside {@link ALLOWED_AE_FUNCTIONS}. Local
 * mode: ClickHouse's HTTP interface. Production: the real Analytics
 * Engine SQL API. The production path follows Cloudflare's documented
 * request/response shape but is NOT verifiable end to end — the sandbox
 * probe token has no Account Analytics read.
 */
export async function runAeQuery(
  env: AeQueryEnv,
  sql: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AeRow[]> {
  assertAllowedAeQuery(sql);
  if (env.O11Y_ENV === "local") return runLocalClickHouseQuery(env, sql, fetchImpl);
  return runAnalyticsEngineSqlApi(env, sql, fetchImpl);
}

async function runLocalClickHouseQuery(env: AeQueryEnv, sql: string, fetchImpl: typeof fetch): Promise<AeRow[]> {
  const base = (env.RUNNER_EVENTS_CLICKHOUSE_URL ?? "http://localhost:8123").replace(/\/$/, "");
  const query = `${sql} FORMAT JSONEachRow`;
  const res = await fetchImpl(`${base}/?query=${encodeURIComponent(query)}`, {
    method: "GET",
    headers: env.AE_SQL_TOKEN ? { "X-ClickHouse-User": "default", "X-ClickHouse-Key": env.AE_SQL_TOKEN } : {},
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ae-query: local ClickHouse query failed, ${res.status}: ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AeRow);
}

async function runAnalyticsEngineSqlApi(env: AeQueryEnv, sql: string, fetchImpl: typeof fetch): Promise<AeRow[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AE_SQL_TOKEN ?? ""}`,
      "Content-Type": "text/plain",
    },
    body: sql,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ae-query: Analytics Engine SQL API failed, ${res.status}: ${body.slice(0, 200)}`);
  }
  const payload = (await res.json()) as { data?: AeRow[] };
  return payload.data ?? [];
}
