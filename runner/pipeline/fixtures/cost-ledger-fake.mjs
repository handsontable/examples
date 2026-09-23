// A minimal in-memory `env.DB` fake covering exactly the `cost_ledger` and
// `runner_settings` SQL shapes `budget.ts`/`settings.ts`/`reconcile.ts` issue
// — not a general SQL engine, the same "cover exactly what the routes touch"
// scope `worker-harness.mjs#fakeD1` documents for the demos/tokens tables.
// Used by T04's `o11y-cost.test.mjs`/`o11y-alerts.test.mjs` (the o11y spend
// cap rule reads through `budget.ts#computeO11ySpend`).

/** @returns {{ DB: object, _ledger: Map, _settings: Map }} */
export function fakeCostD1(seedLedgerRows = []) {
  // key: `${day}|${sku}|${source}`
  const ledger = new Map();
  for (const row of seedLedgerRows) {
    ledger.set(`${row.day}|${row.sku}|${row.source}`, { ...row, updated_at: row.updated_at ?? Date.now() });
  }
  const settings = new Map(); // key -> { value, updated_at, updated_by }

  function upsertEstimateRow(day, sku, units, usd, updatedAt) {
    const key = `${day}|${sku}|estimate`;
    const existing = ledger.get(key);
    if (existing) {
      ledger.set(key, { day, sku, source: "estimate", units: existing.units + units, usd: existing.usd + usd, updated_at: updatedAt });
    } else {
      ledger.set(key, { day, sku, source: "estimate", units, usd, updated_at: updatedAt });
    }
  }

  function setBillingRow(day, sku, units, usd, updatedAt) {
    ledger.set(`${day}|${sku}|billing`, { day, sku, source: "billing", units, usd, updated_at: updatedAt });
  }

  const DB = {
    prepare(sql) {
      let binds = [];
      const stmt = {
        bind(...args) {
          binds = args;
          return stmt;
        },
        async run() {
          if (/INSERT INTO cost_ledger/.test(sql) && /'estimate'/.test(sql)) {
            const [day, sku, units, usd, updatedAt] = binds;
            upsertEstimateRow(day, sku, units, usd, updatedAt);
            return { success: true };
          }
          if (/INSERT INTO cost_ledger/.test(sql) && /'billing'/.test(sql)) {
            const [day, sku, units, usd, updatedAt] = binds;
            setBillingRow(day, sku, units, usd, updatedAt);
            return { success: true };
          }
          if (/DELETE FROM cost_ledger/.test(sql)) {
            const [cutoff] = binds;
            for (const [key, row] of [...ledger]) if (row.day < cutoff) ledger.delete(key);
            return { success: true };
          }
          if (/INSERT INTO runner_settings/.test(sql)) {
            const [key, value, updatedAt, updatedBy] = binds;
            settings.set(key, { value, updated_at: updatedAt, updated_by: updatedBy });
            return { success: true };
          }
          if (/DELETE FROM runner_settings/.test(sql)) {
            const [key] = binds;
            settings.delete(key);
            return { success: true };
          }
          throw new Error(`fakeCostD1: unhandled run() SQL: ${sql}`);
        },
        async all() {
          if (/FROM cost_ledger WHERE day >= /.test(sql)) {
            const [since] = binds;
            const rows = [...ledger.values()].filter((r) => r.day >= since).sort((a, b) => (a.day < b.day ? 1 : -1));
            return { results: rows };
          }
          if (/FROM cost_ledger/.test(sql) && /GROUP BY day, sku/.test(sql)) {
            const [dayLike] = binds;
            const prefix = dayLike.replace(/%$/, "");
            const skuMatch = /sku IN \(([^)]+)\)/.exec(sql);
            const allowedSkus = skuMatch ? skuMatch[1].split(",").map((s) => s.trim().replace(/'/g, "")) : null;
            const byDaySku = new Map();
            for (const row of ledger.values()) {
              if (!row.day.startsWith(prefix)) continue;
              if (allowedSkus && !allowedSkus.includes(row.sku)) continue;
              const key = `${row.day}|${row.sku}`;
              const existing = byDaySku.get(key);
              // COALESCE(billing, estimate, 0), same precedence as the real query.
              if (!existing || row.source === "billing") byDaySku.set(key, row);
              else if (existing.source !== "billing") byDaySku.set(key, row);
            }
            return { results: [...byDaySku.values()].map((r) => ({ usd: r.usd, reconciled: r.source === "billing" ? 1 : 0 })) };
          }
          throw new Error(`fakeCostD1: unhandled all() SQL: ${sql}`);
        },
        async first() {
          if (/FROM runner_settings WHERE key = /.test(sql)) {
            const [key] = binds;
            const row = settings.get(key);
            return row ? { value: row.value, updated_at: row.updated_at, updated_by: row.updated_by } : null;
          }
          throw new Error(`fakeCostD1: unhandled first() SQL: ${sql}`);
        },
      };
      return stmt;
    },
    batch(stmts) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };

  return { DB, _ledger: ledger, _settings: settings };
}
