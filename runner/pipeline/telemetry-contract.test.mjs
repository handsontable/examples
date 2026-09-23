// Proves `packages/runtime/src/telemetry/{attrs,metrics}.ts` agrees with
// `docs/observability-contract.md` §3, §4 and §5 — slot for slot, outcome for
// outcome. Parses the doc from disk (not a hand-copied fixture), so editing
// either side alone fails this file: the README's "Contract" rule made
// mechanical.
//
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build` — this
// file imports the telemetry module from `packages/runtime/dist/` (the
// `../packages/runtime/dist/...` convention `dep-shims.test.mjs` and friends
// use; the root `pnpm test` script builds it first, by design, see AGENTS.md).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AE_COLUMNS,
  ENVIRONMENTS,
  HOT_KINDS,
  HT_MAJORS,
  METRICS,
  METRIC_NAMES,
  RESOURCE_ATTRS,
  SERVICE_NAMES,
  STRUCTURED_METADATA_KEYS,
  SURFACES,
  TIERS,
} from "../packages/runtime/dist/telemetry/index.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const doc = fs.readFileSync(path.join(dir, "..", "docs", "observability-contract.md"), "utf8");

// ---- Generic markdown-table helpers ---------------------------------------------

function section(startHeading, endHeading) {
  const start = doc.indexOf(startHeading);
  assert.notEqual(start, -1, `heading not found: ${startHeading}`);
  const from = start + startHeading.length;
  const end = doc.indexOf(endHeading, from);
  assert.notEqual(end, -1, `heading not found: ${endHeading}`);
  return doc.slice(from, end);
}

/** Rows of a single markdown table within `text`: header + separator skipped,
 *  each data row split into trimmed cells. */
function tableRows(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|"));
  return lines.slice(2).map((line) => line.slice(1, -1).split("|").map((c) => c.trim()));
}

/** Split on `delimiter` at paren-depth 0 — a comma inside `(...)` (e.g.
 *  `reason (\`live\`, \`builder\`)`) does not split. */
function splitTopLevel(cell, delimiter) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of cell) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function backtickTokens(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

// ---- §3: attributes ---------------------------------------------------------

test("§3 resource attributes match attrs.ts, key for key, slot for slot, label for label", () => {
  const body = section("## 3. Attributes", "## 4.");
  const rows = tableRows(body);
  const parsed = rows.map(([keyCell, valuesCell, labelCell, slotCell]) => ({
    key: keyCell.replace(/`/g, ""),
    valuesCell,
    lokiLabel: labelCell === "no" ? undefined : labelCell.replace(/`/g, ""),
    aeSlot: slotCell.replace(/`/g, ""),
  }));

  const byKey = new Map(RESOURCE_ATTRS.map((a) => [a.key, a]));
  assert.deepEqual(
    new Set(parsed.map((p) => p.key)),
    new Set(byKey.keys()),
    "§3 attribute keys and RESOURCE_ATTRS must name exactly the same set",
  );

  for (const p of parsed) {
    const mod = byKey.get(p.key);
    assert.equal(mod.lokiLabel, p.lokiLabel, `${p.key}: Loki label`);
    assert.equal(mod.aeSlot, p.aeSlot, `${p.key}: AE slot`);
  }

  // Closed-set values, only for the attributes the doc actually enumerates
  // (hot.framework and hot.outcome are prose — "a key of config/frameworks.json…"
  // and "per metric, see §5" — not enumerable here).
  const closedSets = {
    "service.name": SERVICE_NAMES,
    "deployment.environment.name": ENVIRONMENTS,
    "hot.surface": SURFACES,
    "hot.tier": TIERS,
    "hot.ht_major": HT_MAJORS,
  };
  for (const p of parsed) {
    const expected = closedSets[p.key];
    if (!expected) continue;
    const range = /`(\d+)`\s*…\s*`(\d+)`/.exec(p.valuesCell);
    let values = backtickTokens(p.valuesCell);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      const expanded = [];
      for (let n = lo; n <= hi; n++) expanded.push(String(n));
      values = [...expanded, ...values.filter((v) => v !== range[1] && v !== range[2])];
    }
    assert.deepEqual(new Set(values), new Set(expected), `${p.key}: closed-set values`);
  }
});

test("§3 structured-metadata-only keys match STRUCTURED_METADATA_KEYS", () => {
  const marker = "Structured metadata only";
  const start = doc.indexOf(marker);
  assert.notEqual(start, -1, "structured-metadata paragraph not found");
  const paragraphEnd = doc.indexOf("\n\n", start);
  const paragraph = doc.slice(start, paragraphEnd === -1 ? undefined : paragraphEnd);
  const keys = backtickTokens(paragraph).filter((t) => /^[a-z]+\.[a-z_]+$/.test(t));
  assert.deepEqual(new Set(keys), new Set(STRUCTURED_METADATA_KEYS));

  // "`hot.kind` (the Faro item kind: `exception`, `log`, `event`, `measurement`)"
  // — HOT_KINDS is attrs.ts's closed set for this key; pin it to the doc too.
  const hotKindIdx = paragraph.indexOf("`hot.kind`");
  assert.notEqual(hotKindIdx, -1, "hot.kind not found in the structured-metadata paragraph");
  const hotKindValues = backtickTokens(paragraph.slice(hotKindIdx + "`hot.kind`".length));
  assert.deepEqual(new Set(hotKindValues), new Set(HOT_KINDS));
});

// ---- §4: Analytics Engine layout ----------------------------------------------

test("§4 Analytics Engine layout matches AE_COLUMNS, column for column, slot for slot", () => {
  const body = section("## 4. Analytics Engine layout", "## 5.");
  const rows = tableRows(body);
  const parsed = {};
  for (const [slotCell, columnCell] of rows) {
    if (columnCell.trim() === "—") continue; // an unassigned slot (or range)
    parsed[columnCell.replace(/`/g, "")] = slotCell.replace(/`/g, "");
  }
  assert.deepEqual(parsed, { ...AE_COLUMNS });
});

// ---- §5: metric registry -------------------------------------------------------

function parseBlobsCell(cell) {
  if (cell.trim() === "—") return { blobs: [], values: {} };
  const blobs = [];
  const values = {};
  for (const token of splitTopLevel(cell, ",")) {
    const eq = /^([a-z_.]+)\s*=\s*`([^`]+)`$/i.exec(token);
    if (eq) {
      blobs.push(eq[1]);
      values[eq[1]] = [eq[2]];
      continue;
    }
    const paren = /^([a-z_.]+)\s*\(([^)]*)\)$/i.exec(token);
    if (paren) {
      blobs.push(paren[1]);
      const inner = backtickTokens(paren[2]);
      if (inner.length > 0) values[paren[1]] = inner;
      continue;
    }
    const plain = /^([a-z_.]+)$/i.exec(token);
    if (plain) {
      blobs.push(plain[1]);
      continue;
    }
    throw new Error(`telemetry-contract.test.mjs: unparseable Blobs token "${token}" in "${cell}"`);
  }
  return { blobs, values };
}

function parseDoublesCell(cell) {
  if (cell.trim() === "—") return [];
  return splitTopLevel(cell, ",").map((token) => {
    const m = /^([a-z_]+)/i.exec(token);
    if (!m) throw new Error(`telemetry-contract.test.mjs: unparseable Doubles token "${token}" in "${cell}"`);
    return m[1];
  });
}

function parseOutcomesCell(cell, blobs) {
  const result = { outcome: undefined, reason: undefined, outcomeAlias: undefined };
  if (cell.trim() === "—") return result;
  const hasOutcome = blobs.includes("outcome");
  const hasReason = blobs.includes("reason");
  let unlabeledUsed = false;
  for (const clause of splitTopLevel(cell, ";")) {
    const alias = /^outcomes\s+as\s+`([^`]+)`$/i.exec(clause);
    if (alias) {
      result.outcomeAlias = alias[1];
      continue;
    }
    if (/^reason\s*=/i.test(clause)) {
      // "reason = gate" — explicitly open, no fixed values.
      result.reason = result.reason ?? [];
      continue;
    }
    if (/^reason:?\s+/i.test(clause)) {
      result.reason = [...(result.reason ?? []), ...backtickTokens(clause)];
      continue;
    }
    if (/^outcome:?\s+/i.test(clause)) {
      result.outcome = [...(result.outcome ?? []), ...backtickTokens(clause)];
      continue;
    }
    const tokens = backtickTokens(clause);
    if (tokens.length === 0) {
      throw new Error(`telemetry-contract.test.mjs: unparseable Outcomes/reason clause "${clause}"`);
    }
    if (unlabeledUsed) {
      throw new Error(`telemetry-contract.test.mjs: two unlabeled clauses in "${cell}"`);
    }
    unlabeledUsed = true;
    if (hasOutcome) result.outcome = [...(result.outcome ?? []), ...tokens];
    else if (hasReason) result.reason = [...(result.reason ?? []), ...tokens];
    else throw new Error(`telemetry-contract.test.mjs: unlabeled values but no outcome/reason blob: "${cell}"`);
  }
  return result;
}

function parseMetricRow([namesCell, , blobsCell, doublesCell, outcomesCell]) {
  const names = splitTopLevel(namesCell, ",").map((n) => n.replace(/`/g, ""));
  const { blobs, values: blobValues } = parseBlobsCell(blobsCell);
  const doubles = parseDoublesCell(doublesCell);
  const parsedOutcomes = parseOutcomesCell(outcomesCell, blobs);

  const values = { ...blobValues };
  if (parsedOutcomes.outcome) values.outcome = [...(values.outcome ?? []), ...parsedOutcomes.outcome];
  if (parsedOutcomes.reason) values.reason = [...(values.reason ?? []), ...parsedOutcomes.reason];

  return { names, blobs, doubles, values, outcomeAlias: parsedOutcomes.outcomeAlias };
}

/** Drop empty-array entries (an explicit "open, no fixed values" marker, e.g.
 *  "reason = gate") so they compare equal to a genuinely absent key, and sort
 *  every surviving array so order never matters. */
function normalizeValues(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (Array.isArray(v) && v.length > 0) out[k] = [...v].sort();
  }
  return out;
}

test("§5 metric registry matches METRICS, slot for slot and outcome for outcome", () => {
  const body = section("## 5. Metric registry", "## 6.");
  const rawRows = tableRows(body).map(parseMetricRow);

  const byName = new Map();
  for (const row of rawRows) {
    for (const name of row.names) {
      byName.set(name, { blobs: row.blobs, doubles: row.doubles, values: row.values, outcomeAlias: row.outcomeAlias });
    }
  }

  for (const [name, entry] of byName) {
    if (!entry.outcomeAlias) continue;
    const target = byName.get(entry.outcomeAlias);
    assert.ok(target, `${name}: outcome alias "${entry.outcomeAlias}" not found in the table`);
    entry.values = { ...entry.values, outcome: target.values.outcome };
  }

  assert.deepEqual(
    new Set(byName.keys()),
    new Set(METRIC_NAMES),
    "§5 metric names and MetricName must name exactly the same set",
  );

  for (const [name, entry] of byName) {
    const mod = METRICS[name];
    assert.deepEqual(new Set(entry.blobs), new Set(mod.blobs), `${name}: blobs`);
    assert.deepEqual(new Set(entry.doubles), new Set(mod.doubles), `${name}: doubles`);
    assert.deepEqual(normalizeValues(entry.values), normalizeValues(mod.values ?? {}), `${name}: values (outcome/reason/fixed)`);
  }
});
