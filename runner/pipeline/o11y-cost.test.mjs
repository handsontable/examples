// T04 — ADR-0041 §G: "observability spend is its own number with its own
// cap." Covers `budget.ts#recordContainerUsage`'s new `sku` parameter,
// `computeO11ySpend`, `settings.ts#o11yBudgetUsd`, `o11y-usage.ts#O11yUsage`
// (the named `WorkerEntrypoint` the o11y worker's `cost.ts` calls over the
// `API` binding), and `reconcile.ts` iterating both scripts.
//
// Run: node --experimental-strip-types --test pipeline/o11y-cost.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { fakeCostD1 } from "./fixtures/cost-ledger-fake.mjs";
import { fakeKV } from "./fixtures/worker-harness.mjs";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const { recordContainerUsage, computeO11ySpend, SESSION_INSTANCE_TYPE } = await import("../workers/api/src/budget.ts");
const { defaultSettings, validateSettings } = await import("../workers/api/src/settings.ts");
const { O11yUsage } = await import("../workers/api/src/o11y-usage.ts");
const { reconcileBilling } = await import("../workers/api/src/reconcile.ts");

function makeEnv(seedLedgerRows = []) {
  const { DB, _ledger } = fakeCostD1(seedLedgerRows);
  const CACHE = fakeKV();
  return {
    env: {
      DB,
      CACHE,
      RUNNER_EVENTS: undefined,
      O11Y_ENV: "local",
      PREVIEW_HOST: undefined,
    },
    ledger: _ledger,
  };
}

test("recordContainerUsage: sku defaults to 'container'", async () => {
  const { env, ledger } = makeEnv();
  await recordContainerUsage(env, { instanceType: SESSION_INSTANCE_TYPE, awakeSeconds: 100 });
  const day = new Date().toISOString().slice(0, 10);
  const row = ledger.get(`${day}|container|estimate`);
  assert.ok(row, "expected a 'container' sku row");
  assert.equal(row.units, 100);
});

test("recordContainerUsage: an explicit sku writes under that sku, not 'container'", async () => {
  const { env, ledger } = makeEnv();
  await recordContainerUsage(env, { instanceType: SESSION_INSTANCE_TYPE, awakeSeconds: 60, sku: "o11y_container" });
  const day = new Date().toISOString().slice(0, 10);
  assert.ok(ledger.get(`${day}|o11y_container|estimate`), "expected an 'o11y_container' row");
  assert.equal(ledger.get(`${day}|container|estimate`), undefined, "must not also write the app's 'container' sku");
});

test("computeO11ySpend: sums only o11y_container/o11y_workers, never the app's own skus", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const { env } = makeEnv([
    { day: `${month}-01`, sku: "o11y_container", source: "estimate", units: 100, usd: 1.5 },
    { day: `${month}-02`, sku: "o11y_workers", source: "estimate", units: 10, usd: 0.5 },
    { day: `${month}-01`, sku: "container", source: "estimate", units: 9999, usd: 999 }, // app sku — must be ignored
  ]);
  const spend = await computeO11ySpend(env);
  assert.equal(spend.spendUsd, 2, `expected 1.5 + 0.5 = 2, got ${spend.spendUsd}`);
  assert.equal(spend.capUsd, 15, "default O11Y_BUDGET_USD is $15");
});

// Minor triage item 9 (C-findings.md T04: "no rollover test for alert
// state ... month rollover of the cap is a plain month-prefix LIKE"). This
// pins the ledger half of that claim directly: a heavy prior-month spend
// must NOT leak into the current month's month-prefix LIKE read — the exact
// mechanism that makes the o11y-spend-cap alert self-resolve once the
// calendar rolls over, even with no code path that explicitly "resets"
// anything (there is none — the LIKE filter itself is the reset). The
// alert-state half of the same rollover (o11yCapRule firing on last month's
// high spend, then correctly resolving once this month's read comes back
// near zero) is pinned in `pipeline/o11y-alerts.test.mjs`'s own
// month-rollover test, through the SAME `computeO11ySpend`-shaped values.
// Reverting `computeO11ySpend`'s `day LIKE ?1` filter (e.g. back to an
// unbounded `SELECT ... FROM cost_ledger WHERE sku IN (...)`) makes the
// assertion below fail: spend would come back $500 instead of $0.
test("computeO11ySpend: a previous month's spend does not carry over after the calendar rolls into a new month", async () => {
  const now = new Date();
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const lastMonthPrefix = lastMonthDate.toISOString().slice(0, 7);
  const thisMonthPrefix = now.toISOString().slice(0, 7);
  assert.notEqual(lastMonthPrefix, thisMonthPrefix, "test precondition: the two prefixes must actually differ");

  const { env } = makeEnv([
    // A huge prior-month spend, well over any real cap — must not count.
    { day: `${lastMonthPrefix}-15`, sku: "o11y_container", source: "estimate", units: 100_000, usd: 500 },
  ]);
  const spend = await computeO11ySpend(env);
  assert.equal(spend.spendUsd, 0, "the previous month's spend must not carry into this month's read");
});

test("computeO11ySpend: a 'billing' row outranks an 'estimate' row for the same (day, sku)", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const { env } = makeEnv([
    { day: `${month}-01`, sku: "o11y_workers", source: "estimate", units: 10, usd: 5 },
    { day: `${month}-01`, sku: "o11y_workers", source: "billing", units: 10, usd: 1 },
  ]);
  const spend = await computeO11ySpend(env);
  assert.equal(spend.spendUsd, 1, "billing (1) must win over estimate (5)");
});

test("settings: o11yBudgetUsd defaults to 15 and is validated", async () => {
  const env = { O11Y_BUDGET_USD: undefined, BUDGET_ALERTS_USD: undefined };
  const defaults = defaultSettings(env);
  assert.equal(defaults.o11yBudgetUsd, 15);

  const ok = validateSettings({
    limitUsd: 1000, warnUsd: 100, anonBlockUsd: 200, newBlockUsd: 300, closedUsd: 400,
    enforce: false, alertsUsd: [], o11yBudgetUsd: 25,
  });
  assert.ok(ok.ok, ok.ok ? "" : ok.error);
  assert.equal(ok.value.o11yBudgetUsd, 25);

  const rejected = validateSettings({
    limitUsd: 1000, warnUsd: 100, anonBlockUsd: 200, newBlockUsd: 300, closedUsd: 400,
    enforce: false, alertsUsd: [], o11yBudgetUsd: 0,
  });
  assert.equal(rejected.ok, false, "o11yBudgetUsd <= 0 must be rejected");
});

test("settings: a payload with no o11yBudgetUsd at all still validates (defaults to 15)", async () => {
  const ok = validateSettings({
    limitUsd: 1000, warnUsd: 100, anonBlockUsd: 200, newBlockUsd: 300, closedUsd: 400,
    enforce: false, alertsUsd: [],
  });
  assert.ok(ok.ok, ok.ok ? "" : ok.error);
  assert.equal(ok.value.o11yBudgetUsd, 15);
});

test("O11yUsage (WorkerEntrypoint): recordAwakeSeconds writes the o11y_container sku", async () => {
  const { env, ledger } = makeEnv();
  const usage = new O11yUsage({}, env);
  await usage.recordAwakeSeconds(120);
  const day = new Date().toISOString().slice(0, 10);
  const row = ledger.get(`${day}|o11y_container|estimate`);
  assert.ok(row, "expected an o11y_container row");
  assert.equal(row.units, 120);
});

test("O11yUsage: recordAwakeSeconds(0) writes nothing (never a zero-second cost row)", async () => {
  const { env, ledger } = makeEnv();
  const usage = new O11yUsage({}, env);
  await usage.recordAwakeSeconds(0);
  assert.equal(ledger.size, 0);
});

test("O11yUsage: o11ySpend() answers the same shape computeO11ySpend does", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const { env } = makeEnv([{ day: `${month}-01`, sku: "o11y_container", source: "estimate", units: 1, usd: 3 }]);
  const usage = new O11yUsage({}, env);
  const spend = await usage.o11ySpend();
  assert.equal(spend.spendUsd, 3);
  assert.equal(spend.capUsd, 15);
});

test("reconcileBilling: iterates both scripts, writes o11y_workers for the o11y script, leaves the app's container row untouched", async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const { env, ledger } = makeEnv([
    // A pre-existing app 'container' estimate row — reconcile never queries
    // that sku (no public per-account dataset for it, same as the app's own
    // container sku), so this must survive the run byte-for-byte.
    { day: yesterday, sku: "container", source: "estimate", units: 500, usd: 12.5 },
  ]);
  const before = { ...ledger.get(`${yesterday}|container|estimate`) };

  env.CF_ANALYTICS_TOKEN = "test-token";
  env.CF_ACCOUNT_ID = "acct";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    // `reconcile.run`'s own `emitPoint` call also touches `fetch` (the local
    // ClickHouse sink) — only intercept the GraphQL endpoint this test cares
    // about; let anything else fail harmlessly (emitPoint swallows it).
    if (!String(url).includes("/client/v4/graphql")) {
      return { ok: false, status: 599, json: async () => ({}), text: async () => "not mocked" };
    }
    const body = JSON.parse(init.body);
    const script = body.variables.script;
    const requests = script === "handsontable-demos-o11y" ? 2_000_000 : 5_000_000;
    return {
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [{ sum: { requests } }],
                durableObjectsInvocationsAdaptiveGroups: script === "handsontable-demos-api"
                  ? [{ sum: { requests: 1000, responseBodySize: 1_000_000_000 } }]
                  : [],
                r2StorageAdaptiveGroups: [],
              },
            ],
          },
        },
      }),
      text: async () => "",
    };
  };
  try {
    await reconcileBilling(env);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const appWorkersRow = ledger.get(`${yesterday}|workers|billing`);
  assert.ok(appWorkersRow, "expected the app's 'workers' billing row");
  assert.equal(appWorkersRow.units, 5_000_000);

  const o11yWorkersRow = ledger.get(`${yesterday}|o11y_workers|billing`);
  assert.ok(o11yWorkersRow, "expected an 'o11y_workers' billing row for the o11y script");
  assert.equal(o11yWorkersRow.units, 2_000_000);

  // No o11y_container/container billing row was ever written by this run —
  // container compute is never queried (no public dataset for it).
  assert.equal(ledger.get(`${yesterday}|o11y_container|billing`), undefined);

  const after = ledger.get(`${yesterday}|container|estimate`);
  assert.deepEqual(after, before, "the app's pre-existing 'container' estimate row must be unchanged");
});
