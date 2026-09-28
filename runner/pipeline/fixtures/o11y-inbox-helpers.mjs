// Test-only helper for `pipeline/o11y-inbox.test.mjs`: production reads
// pending rows only through the bounded `pack.ts#collectRowBatch`.

const ROW_PREFIX = "row:";

function rowNumber(key) {
  return Number(key.slice(ROW_PREFIX.length));
}

/** All pending rows, grouped by tenant, in row-insertion order (numeric sort
 *  in memory — unbounded, so this is for tests only, over a small, known row
 *  count). */
export async function pendingRowsByTenant(storage) {
  const rows = await storage.list({ prefix: ROW_PREFIX });
  const sorted = [...rows.entries()].sort(([a], [b]) => rowNumber(a) - rowNumber(b));
  const byTenant = new Map();
  for (const entry of sorted) {
    const list = byTenant.get(entry[1].tenant) ?? [];
    list.push(entry);
    byTenant.set(entry[1].tenant, list);
  }
  return byTenant;
}
