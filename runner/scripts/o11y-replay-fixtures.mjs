#!/usr/bin/env node
// Replays every `pipeline/fixtures/{otlp,faro}/**` fixture against a running
// o11y worker (`wrangler dev`), per the task's Verify block:
//
//   ( cd workers/o11y && npx wrangler dev )
//   node scripts/o11y-replay-fixtures.mjs --base http://localhost:4300
//
// Every route requires a real gate: Faro fixtures get a fresh Origin +
// timestamp (a stale JSON timestamp would fall outside the ±5 min clamp
// window and exercise the fallback instead of the intended value); OTLP
// fixtures get the `x-o11y-secret` header from `.dev.vars`; the deploy and
// Sentry fixtures get their own gates. `--base` defaults to
// `http://localhost:4300` (this task's port block, COMMON.md).
//
// Exits non-zero if any fixture does not answer 2xx.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex !== -1 ? args[baseIndex + 1] : "http://localhost:4300";

const ROOT = fileURLToPath(new URL("../pipeline/fixtures/", import.meta.url));
const EXPORT_SECRET = process.env.O11Y_EXPORT_SECRET ?? "";
const SENTRY_SECRET = process.env.SENTRY_HOOK_SECRET ?? "";

if (!EXPORT_SECRET) {
  console.warn("O11Y_EXPORT_SECRET not set — v1/logs and deploy fixtures will 401. Export it from .dev.vars first.");
}
if (!SENTRY_SECRET) {
  console.warn("SENTRY_HOOK_SECRET not set — the Sentry hook fixture will 401. Export it from .dev.vars first.");
}

let failures = 0;

async function post(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body });
  const ok = res.status >= 200 && res.status < 300;
  console.log(`${ok ? "OK " : "FAIL"} ${res.status} POST ${path} (${body.length} bytes)`);
  if (!ok) {
    failures++;
    console.log(`  ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

/** Faro fixtures embed a JSON `timestamp` field per item — stamp it fresh
 *  (see the file header) and inject one item with a timestamp far outside
 *  the ±5 min clamp window, so the clamp-to-`received_at` fallback is
 *  actually exercised by at least one item per replay, not only the
 *  in-window happy path. */
function freshenFaro(text) {
  const body = JSON.parse(text);
  let stampedOne = false;
  for (const key of ["exceptions", "logs", "measurements", "events"]) {
    for (const item of body[key] ?? []) {
      if (!stampedOne) {
        item.timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h out of window
        stampedOne = true;
      } else {
        item.timestamp = new Date().toISOString();
      }
    }
  }
  return JSON.stringify(body);
}

async function replayFaro() {
  for (const name of readdirSync(`${ROOT}faro`)) {
    const text = readFileSync(`${ROOT}faro/${name}`, "utf8");
    await post("/telemetry/collect", freshenFaro(text), {
      Origin: base.startsWith("http://localhost") ? "http://localhost:4300" : "https://demos.handsontable.com",
      "content-type": "application/json",
    });
  }
}

async function replayOtlpJson() {
  for (const name of readdirSync(`${ROOT}otlp/json`)) {
    const text = readFileSync(`${ROOT}otlp/json/${name}`, "utf8");
    await post("/telemetry/v1/logs", text, {
      "x-o11y-secret": EXPORT_SECRET,
      "content-type": "application/json",
    });
  }
}

async function replayOtlpProtobuf() {
  for (const name of readdirSync(`${ROOT}otlp/protobuf`)) {
    const bytes = readFileSync(`${ROOT}otlp/protobuf/${name}`);
    await post("/telemetry/v1/logs", bytes, {
      "x-o11y-secret": EXPORT_SECRET,
      "content-type": "application/x-protobuf",
    });
  }
}

async function replayDeploy() {
  const text = readFileSync(`${ROOT}otlp/deploy-event.json`, "utf8");
  await post("/telemetry/deploy", text, {
    "x-o11y-secret": EXPORT_SECRET,
    "content-type": "application/json",
  });
}

async function replaySentry() {
  const text = readFileSync(`${ROOT}otlp/sentry-issue.json`, "utf8");
  const sig = createHmac("sha256", SENTRY_SECRET).update(text).digest("hex");
  await post("/telemetry/hooks/sentry", text, {
    "sentry-hook-signature": sig,
    "content-type": "application/json",
  });
}

async function replayDuplicate() {
  // Exit criterion 4, against the real dev server: the same body twice,
  // seconds apart. Both must answer 2xx; the duplicate point is asserted by
  // the pipeline tests, not observable from this script alone without a
  // Grafana/AE reader.
  const text = readFileSync(`${ROOT}otlp/json/zero-timestamp.json`, "utf8");
  const headers = { "x-o11y-secret": EXPORT_SECRET, "content-type": "application/json" };
  await post("/telemetry/v1/logs", text, headers);
  await new Promise((r) => setTimeout(r, 2000));
  await post("/telemetry/v1/logs", text, headers);
}

console.log(`Replaying fixtures against ${base} …`);
await replayFaro();
await replayOtlpJson();
await replayOtlpProtobuf();
await replayDeploy();
await replaySentry();
await replayDuplicate();

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.`);
  process.exit(1);
}
console.log("\nAll fixtures replayed successfully.");
