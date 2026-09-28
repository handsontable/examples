// Contract §3: `hot.framework` and `hot.outcome` are Loki labels, so every
// ingest path must map a client-sent value into a known set. Each distinct label
// tuple is a Loki stream, and an inbox object with more streams than the box's
// per-tenant limit is refused by Loki.
// Build prerequisite: `pnpm --filter @handsontable/demo-runtime build`.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { processFaroBody, MAX_FARO_ITEMS_PER_BODY } = await import("../workers/o11y/src/normalise/faro.ts");
const { processOtlpBody } = await import("../workers/o11y/src/normalise/otlp.ts");
const { beaconToRecord, KNOWN_FRAMEWORKS, RECORD_OUTCOMES, AE_COLUMNS, SURFACES, TIERS, HT_MAJORS, LITE_SURFACES, RESOURCE_ATTRS } =
  await import(
  "../packages/runtime/dist/telemetry/index.js"
);

const ENV = { O11Y_ENV: "production" };
const SERVICE = { name: "demos-authoring", version: "deadbeef1234", environment: "production" };
const DISTINCT = 6000;

/** One packed inbox object's worth of Faro logs (30 bodies of 200 items, one
 *  60 s pack window from a single IP), each item with its own attribute value. */
async function storedFaroLogs(attrKey) {
  const records = [];
  for (let start = 0; start < DISTINCT; start += MAX_FARO_ITEMS_PER_BODY) {
    const logs = [];
    for (let n = start; n < start + MAX_FARO_ITEMS_PER_BODY; n++) {
      logs.push({ message: `m${n}`, timestamp: new Date().toISOString(), context: { [attrKey]: `v${n}` } });
    }
    const body = { meta: { app: { name: "demos-authoring", version: "deadbeef1234" } }, logs };
    for (const item of await processFaroBody(body, ENV, SERVICE, Date.now())) {
      if (item.ingestItem?.record) records.push(item.ingestItem.record);
    }
  }
  return records;
}

function distinct(records, key) {
  return new Set(records.map((r) => r.resourceAttributes[key]));
}

test(`Faro: ${DISTINCT} distinct hot.outcome values on logs store at most |record outcomes|+1 label values`, async () => {
  const records = await storedFaroLogs("hot.outcome");
  assert.equal(records.length, DISTINCT, "every log is still stored");
  const values = distinct(records, "hot.outcome");
  assert.ok(values.size <= RECORD_OUTCOMES.length + 1, `got ${values.size} distinct values`);
  assert.deepEqual([...values], ["none"]);
});

test(`Faro: ${DISTINCT} distinct hot.framework values store at most |known frameworks|+1 label values`, async () => {
  const records = await storedFaroLogs("hot.framework");
  assert.equal(records.length, DISTINCT);
  const values = distinct(records, "hot.framework");
  assert.ok(values.size <= KNOWN_FRAMEWORKS.length + 1, `got ${values.size} distinct values`);
  assert.deepEqual([...values], ["other"]);
});

test("Faro: a real framework and outcome pass through unchanged", async () => {
  const now = new Date().toISOString();
  const body = {
    meta: { app: { name: "demos-authoring", version: "deadbeef1234" } },
    logs: [{ message: "hello", timestamp: now, context: { "hot.framework": "react", "hot.outcome": "none" } }],
    events: [{ name: "session.start", timestamp: now, attributes: { "hot.framework": "next.js", "hot.outcome": "ready" } }],
    measurements: [
      { type: "preview.ready_ms", values: { duration_ms: 812 }, timestamp: now, context: { "hot.framework": "vue", "hot.outcome": "timeout" } },
    ],
  };
  const [log, measurement, event] = await processFaroBody(body, ENV, SERVICE, Date.now());

  assert.equal(log.ingestItem.record.resourceAttributes["hot.framework"], "react");
  assert.equal(log.ingestItem.record.resourceAttributes["hot.outcome"], "none");
  // A stored event carries no metric outcome, even when named after a metric.
  assert.equal(event.ingestItem.record.resourceAttributes["hot.framework"], "next.js");
  assert.equal(event.ingestItem.record.resourceAttributes["hot.outcome"], "none");
  // A measurement is AE-only; its point keeps the real outcome and framework.
  assert.equal(measurement.invalid, undefined);
  const [point] = measurement.aePoints;
  const blob = (column) => point.blobs[Number(AE_COLUMNS[column].slice(4)) - 1];
  assert.equal(blob("outcome"), "timeout");
  assert.equal(blob("framework"), "vue");
});

test("Faro: a metric outcome on a log is stored as none", async () => {
  const body = {
    meta: { app: { name: "demos-authoring", version: "deadbeef1234" } },
    logs: [{ message: "hello", timestamp: new Date().toISOString(), context: { "hot.outcome": "ready" } }],
  };
  const [log] = await processFaroBody(body, ENV, SERVICE, Date.now());
  assert.equal(log.ingestItem.record.resourceAttributes["hot.outcome"], "none");
});

/** The values each Loki label can take on a stored browser record, per route:
 *  collect items (outcome always `none`) and lite errors (tier `static`).
 *  `service.name` and the environment are fixed by the route. */
const FRAMEWORK_VALUES = [...KNOWN_FRAMEWORKS, "other"];
const REACHABLE_BY_ROUTE = {
  collect: {
    "service.name": ["demos-authoring"],
    "deployment.environment.name": ["production"],
    "hot.surface": SURFACES,
    "hot.tier": TIERS,
    "hot.framework": FRAMEWORK_VALUES,
    "hot.ht_major": HT_MAJORS,
    "hot.outcome": RECORD_OUTCOMES,
  },
  lite: {
    "service.name": ["demos-embed"],
    "deployment.environment.name": ["production"],
    "hot.surface": LITE_SURFACES,
    "hot.tier": ["static"],
    "hot.framework": FRAMEWORK_VALUES,
    "hot.ht_major": HT_MAJORS,
    "hot.outcome": RECORD_OUTCOMES,
  },
};

/** A box Loki config; the files are JSON with `${VAR}` placeholders, some unquoted. */
function lokiConfig(file) {
  const raw = readFileSync(fileURLToPath(new URL(`../containers/o11y/loki/${file}`, import.meta.url)), "utf8");
  return JSON.parse(raw.replace(/"\$\{[A-Z0-9_]+\}"/g, '""').replace(/\$\{[A-Z0-9_]+\}/g, "null"));
}

function indexLabels(config) {
  return config.limits_config.otlp_config.resource_attributes.attributes_config
    .filter((c) => c.action === "index_label")
    .flatMap((c) => c.attributes);
}

/** Streams one route can reach: the product over every label Loki indexes. */
function routeTuples(route, labels) {
  const reachable = REACHABLE_BY_ROUTE[route];
  return labels.reduce((product, label) => {
    assert.ok(reachable[label], `index_label "${label}" has no reachable-value entry for the ${route} route in this test`);
    return product * reachable[label].length;
  }, 1);
}

const LOKI_CONFIGS = ["loki-config.yaml", "loki-config.filesystem.yaml"];

test("the browser tenant's reachable label tuples stay under the box's configured Loki stream limit", () => {
  for (const file of LOKI_CONFIGS) {
    const config = lokiConfig(file);
    const labels = indexLabels(config);
    const limit = config.limits_config.max_global_streams_per_user;
    assert.equal(typeof limit, "number", `${file}: max_global_streams_per_user is set`);
    const collect = routeTuples("collect", labels);
    const lite = routeTuples("lite", labels);
    assert.ok(
      collect + lite < limit,
      `${file}: ${collect} + ${lite} reachable tuples over [${labels.join(", ")}] reach max_global_streams_per_user (${limit})`,
    );
  }
});

test(`Faro: ${DISTINCT} logs with distinct label combinations add no outcome dimension`, async () => {
  const pick = (list, n) => list[n % list.length];
  const records = [];
  const baseTuples = new Set();
  for (let start = 0; start < DISTINCT; start += MAX_FARO_ITEMS_PER_BODY) {
    const logs = [];
    for (let n = start; n < start + MAX_FARO_ITEMS_PER_BODY; n++) {
      // Each surface/tier/framework/major combination is sent twice, once with
      // `none` and once with an unknown outcome.
      const m = Math.floor(n / 2);
      const framework = m % 3 === 0 ? `f${m}` : pick(KNOWN_FRAMEWORKS, Math.floor(m / 28));
      const context = {
        "hot.surface": pick(SURFACES, m),
        "hot.tier": pick(TIERS, Math.floor(m / 7)),
        "hot.framework": framework,
        "hot.ht_major": pick(HT_MAJORS, Math.floor(m / 560)),
        "hot.outcome": n % 2 === 0 ? "none" : `o${n}`,
      };
      const storedFramework = KNOWN_FRAMEWORKS.includes(framework) ? framework : "other";
      baseTuples.add([context["hot.surface"], context["hot.tier"], storedFramework, context["hot.ht_major"]].join("|"));
      logs.push({ message: `m${n}`, timestamp: new Date().toISOString(), context });
    }
    const body = { meta: { app: { name: "demos-authoring", version: "deadbeef1234" } }, logs };
    for (const item of await processFaroBody(body, ENV, SERVICE, Date.now())) {
      if (item.ingestItem?.record) records.push(item.ingestItem.record);
    }
  }
  assert.equal(records.length, DISTINCT);
  const labelKeys = RESOURCE_ATTRS.filter((a) => a.lokiLabel).map((a) => a.key);
  const tuples = new Set(records.map((r) => labelKeys.map((k) => r.resourceAttributes[k]).join("|")));
  assert.equal(tuples.size, baseTuples.size, "one stream per surface/tier/framework/major combination");
  assert.ok(tuples.size <= routeTuples("collect", indexLabels(lokiConfig(LOKI_CONFIGS[0]))));
});

test(`lite beacon: ${DISTINCT} distinct fw values store at most |known frameworks|+1 label values; a real one is kept`, () => {
  const values = new Set();
  for (let n = 0; n < DISTINCT; n++) {
    const record = beaconToRecord(
      { v: 1, t: "err", s: "embed", demo: "abc123", ht: "18", fw: `fw${n}`, n: "TypeError", m: "x", val: null, dev: "desktop", ts: Date.now() },
      { service: SERVICE, receivedAtMs: Date.now() },
    );
    values.add(record.resourceAttributes["hot.framework"]);
  }
  assert.ok(values.size <= KNOWN_FRAMEWORKS.length + 1, `got ${values.size} distinct values`);
  assert.deepEqual([...values], ["other"]);

  const real = beaconToRecord(
    { v: 1, t: "err", s: "embed", demo: "abc123", ht: "18", fw: "angular", n: "TypeError", m: "x", val: null, dev: "desktop", ts: Date.now() },
    { service: SERVICE, receivedAtMs: Date.now() },
  );
  assert.equal(real.resourceAttributes["hot.framework"], "angular");
});

test(`OTLP export: ${DISTINCT} distinct hot.outcome/hot.framework record attributes stay bounded; real values are kept`, async () => {
  const str = (stringValue) => ({ stringValue });
  const logRecords = [];
  for (let n = 0; n < DISTINCT; n++) {
    logRecords.push({
      timeUnixNano: String(1_700_000_000_000_000_000n + BigInt(n)),
      body: str(`line ${n}`),
      attributes: [
        { key: "hot.outcome", value: str(`o${n}`) },
        { key: "hot.framework", value: str(`f${n}`) },
      ],
    });
  }
  logRecords.push({
    timeUnixNano: "1700000000000000000",
    body: str("real"),
    attributes: [
      { key: "hot.outcome", value: str("none") },
      { key: "hot.framework", value: str("remix") },
    ],
  });
  const body = JSON.stringify({
    resourceLogs: [
      { resource: { attributes: [{ key: "service.name", value: str("handsontable-demos-api") }] }, scopeLogs: [{ logRecords }] },
    ],
  });
  const { items } = await processOtlpBody(new TextEncoder().encode(body), "application/json", ENV, Date.now());
  assert.equal(items.length, DISTINCT + 1);
  const records = items.map((i) => i.record);
  const outcomes = distinct(records, "hot.outcome");
  const frameworks = distinct(records, "hot.framework");
  assert.ok(outcomes.size <= RECORD_OUTCOMES.length + 1, `got ${outcomes.size} distinct outcomes`);
  assert.ok(frameworks.size <= KNOWN_FRAMEWORKS.length + 1, `got ${frameworks.size} distinct frameworks`);
  const real = records.at(-1);
  assert.equal(real.resourceAttributes["hot.outcome"], "none");
  assert.equal(real.resourceAttributes["hot.framework"], "remix");
});
