// The query helper ADR-0041 §F.3's alert rules read Analytics Engine
// through (task "Scope": "one helper that allowlists Analytics Engine's
// documented functions"). One place, reused rather than duplicated: T09's
// dashboard lint (`pipeline/o11y-dashboards.test.mjs`) imports
// `ALLOWED_AE_FUNCTIONS` from here instead of keeping its own copy (per the
// controller's "don't keep two diverging allowlists" note) — see that
// file's own header for the pointer.
//
// The function set is Cloudflare's *documented* Analytics Engine SQL API
// surface, read directly from developers.cloudflare.com/analytics/
// analytics-engine/sql-reference/{aggregate,date-time}-functions/ on
// 2026-09-23 (the same pages T09-D5 cites) — `sum`/`avg`/
// `quantileExactWeighted` from the aggregate-functions page, `now`/
// `toStartOfInterval` from the date-time-functions page, `toUInt32` a
// type-conversion function T09 already needed. Never widened to "whatever
// local ClickHouse happens to accept" — that gap is exactly what T09's own
// "Traps" section and T09-D5 warn about.
export const ALLOWED_AE_FUNCTIONS: ReadonlySet<string> = new Set([
  "sum",
  "avg",
  "quantileExactWeighted",
  "toStartOfInterval",
  "toUInt32",
  "now",
]);

/** SQL keywords this module's own queries use — never a function call, and
 *  never flagged by {@link findDisallowedAeFunctions}. Mirrors (a subset
 *  of) T09's own `AE_KEYWORDS`. */
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
  "DISTINCT",
]);

/** Strips string literals before scanning for function-call identifiers —
 *  same tokenising approach as T09's `validateAeQuery` (this module's own
 *  queries carry no Grafana macros, so that half of T09's stripper does not
 *  apply here). */
function stripLiterals(sql: string): string {
  return sql.replace(/'[^']*'/g, "'STR'");
}

/** Every disallowed function call found in `sql` — empty means clean. A
 *  bare identifier (a column reference, not immediately followed by `(`) is
 *  never flagged here; this module's queries are hand-built (not
 *  user-editable dashboard JSON), so the column-existence half of T09's
 *  lint has no equivalent need here. */
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

export function assertAllowedAeQuery(sql: string): void {
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
 * Runs `sql` and returns its rows. Refuses (throws, never silently drops —
 * unlike `emitPoint`'s write side, a rule that cannot read its own query
 * must not silently evaluate as "never fires") any query naming a function
 * outside {@link ALLOWED_AE_FUNCTIONS}.
 *
 * Local mode: ClickHouse's HTTP interface (`?query=...FORMAT JSONEachRow`),
 * the same table/columns `clickhouseSink` writes (contract §10). Production:
 * the real Analytics Engine SQL API
 * (`POST .../analytics_engine/sql`, raw SQL body, bearer `AE_SQL_TOKEN`).
 *
 * **Gap, recorded per COMMON.md**: the production path is written to
 * Cloudflare's documented request/response shape (raw SQL POST body,
 * `{ data: [...] }` JSON response) but is NOT verifiable end to end — the
 * sandbox probe token has no Account Analytics read (COMMON.md's "Probe
 * credentials" section). Local ClickHouse is the only query target this
 * task actually exercised.
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
