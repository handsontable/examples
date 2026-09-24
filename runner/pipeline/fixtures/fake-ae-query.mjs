// A tiny fake Analytics Engine query engine for `pipeline/o11y-alerts.test.mjs`
// (fix round I1): recognises exactly the SQL shapes
// `workers/o11y/src/alerts/rules.ts`'s shared helpers generate — grouped
// `sum(_sample_interval * <count col>)` counts and a `quantileExactWeighted`
// read — and answers them from a plain JS array of seeded rows, so each
// rule's threshold/comparison logic is testable without a live
// ClickHouse/AE endpoint. Column slots are resolved generically via
// `AE_COLUMNS` (never a hand-numbered `blob8`/`double1` literal here
// either), so this fixture stays correct if the contract ever renumbers a
// slot.
//
// Deliberately narrow: throws on any SQL shape it does not recognise,
// rather than silently answering `[]` — a rule that starts generating SQL
// this fixture cannot parse must fail its test loudly, not read as "no
// data".

import { AE_COLUMNS } from "@handsontable/demo-runtime/telemetry";

const SLOT_TO_NAME = Object.fromEntries(Object.entries(AE_COLUMNS).map(([k, v]) => [v, k]));

/**
 * @param {Array<Record<string, unknown> & { metric: string; ageMs?: number }>} rows
 *   Each row is a logical record — `metric`, plus whichever contract column
 *   names (`outcome`, `tier`, `surface`, `demo_id`, `ht_major`,
 *   `duration_ms`, `count`) the rule under test filters/groups/sums on.
 *   `ageMs` (default 0 = "now") is how old the row is, for window filtering.
 */
export function makeFakeAeQuery(rows) {
  const calls = [];

  async function queryFn(_env, sql) {
    calls.push(sql);

    const metricMatch = /index1 = '([^']*)'/.exec(sql);
    const metric = metricMatch?.[1];
    let candidates = rows.filter((r) => r.metric === metric);

    // Window bounds: `timestamp >= now() - INTERVAL 'S' SECOND` (always
    // present) and, for a day-over-day comparison, an upper bound too:
    // `AND timestamp < now() - INTERVAL 'E' SECOND`.
    const startMatch = /timestamp >= now\(\) - INTERVAL '(\d+)' SECOND/.exec(sql);
    const windowStartS = startMatch ? Number(startMatch[1]) : Infinity;
    const endMatch = /timestamp < now\(\) - INTERVAL '(\d+)' SECOND/.exec(sql);
    const windowEndS = endMatch ? Number(endMatch[1]) : -Infinity;
    candidates = candidates.filter((r) => {
      const ageS = (r.ageMs ?? 0) / 1000;
      return ageS <= windowStartS && ageS > windowEndS;
    });

    // Extra equality filters: `AND blobN = 'value'` / `AND doubleN = 'value'`.
    const filterRe = /AND (blob\d+|double\d+) = '([^']*)'/g;
    let fm;
    while ((fm = filterRe.exec(sql))) {
      const logical = SLOT_TO_NAME[fm[1]];
      if (!logical) throw new Error(`fake-ae-query: unknown slot in filter: ${fm[1]}`);
      const value = fm[2];
      candidates = candidates.filter((r) => String(r[logical] ?? "") === value);
    }

    // Set-exclusion filters: `AND blobN NOT IN ('a', 'b', ...)` — minor
    // triage item 6 (`fiveXxRateRule`'s route-class exclusion).
    const notInRe = /AND (blob\d+|double\d+) NOT IN \(([^)]*)\)/g;
    let nim;
    while ((nim = notInRe.exec(sql))) {
      const logical = SLOT_TO_NAME[nim[1]];
      if (!logical) throw new Error(`fake-ae-query: unknown slot in NOT IN filter: ${nim[1]}`);
      const excluded = new Set([...nim[2].matchAll(/'([^']*)'/g)].map((m) => m[1]));
      candidates = candidates.filter((r) => !excluded.has(String(r[logical] ?? "")));
    }

    // `quantileExactWeighted(q)(<col>, toUInt32(_sample_interval)) AS p`
    const qm = /quantileExactWeighted\(([\d.]+)\)\((double\d+),/.exec(sql);
    if (qm) {
      const valueLogical = SLOT_TO_NAME[qm[2]];
      if (!valueLogical) throw new Error(`fake-ae-query: unknown slot in quantile: ${qm[2]}`);
      const values = candidates
        .map((r) => r[valueLogical])
        .filter((v) => typeof v === "number")
        .sort((a, b) => a - b);
      if (values.length === 0) return [];
      const q = Number(qm[1]);
      const idx = Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1));
      return [{ p: values[idx] }];
    }

    // `SELECT <col> AS <alias>, sum(_sample_interval * <countCol>) AS c ... GROUP BY <col>`
    const groupMatch = /SELECT (blob\d+) AS (\w+), sum\(_sample_interval \* (double\d+)\) AS c/.exec(sql);
    if (groupMatch) {
      const groupLogical = SLOT_TO_NAME[groupMatch[1]];
      const countLogical = SLOT_TO_NAME[groupMatch[3]];
      if (!groupLogical || !countLogical) throw new Error(`fake-ae-query: unknown slot in SELECT: ${sql}`);
      const totals = new Map();
      for (const r of candidates) {
        const key = String(r[groupLogical] ?? "");
        totals.set(key, (totals.get(key) ?? 0) + Number(r[countLogical] ?? 1));
      }
      const alias = groupMatch[2];
      return [...totals.entries()].map(([k, c]) => ({ [alias]: k, c }));
    }

    throw new Error(`fake-ae-query: unrecognised SQL shape: ${sql}`);
  }

  return { queryFn, calls };
}
