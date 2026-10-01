// Drain-time symbolication inside a Workers-shaped runtime
// (workers/o11y/src/drain/symbolicate.ts, ADR-0041 §C.3, exit criterion 5).
//
// workerd forbids code generation from strings; a map library that relies on
// it would have every lookup throw inside the real Worker, invisible to a
// Node test since Node allows `new Function`. `symbolicate.ts`'s own header
// explains why it resolves maps with `@jridgewell/trace-mapping` rather than
// a library that does.
//
// The first test here therefore runs the real drain (`drainBatch` with the
// real `symbolicateResourceLogs`) in a child Node process started with
// `--disallow-code-generation-from-strings`, the same V8 policy workerd
// applies, over a real minified `vite build` bundle and its real map. The
// child also reports whether code generation really was blocked, so the
// test cannot pass by quietly running without the policy.
//
// The rest cover the skip signal (`onSkip`) and render-time source-path
// normalisation (`normaliseSourcePath`).
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register, createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { symbolicateResourceLogs, normaliseSourcePath, MAX_SKIP_REPORTS, MAX_MAP_KEYS_PER_CALL, MAX_FRAMES_PER_BODY, MAX_NEW_MAP_KEYS_PER_BODY, MAX_LISTED_VERSIONS_PER_CALL } =
  await import(
  "../workers/o11y/src/drain/symbolicate.ts"
);
const { drainBatch } = await import("../workers/o11y/src/drain/drain.ts");
const { formatStackFrame, scrubTelemetry, faroItemToRecord, buildResourceLogs, encodeNdjson, inboxKey } = await import(
  "@handsontable/demo-runtime/telemetry"
);

const CHILD = fileURLToPath(new URL("./fixtures/o11y-symbolicate-drain-child.mjs", import.meta.url));
const SERVICE_VERSION = "f30-drain-test";
const BUNDLE_URL = "https://demos.handsontable.com/assets/app-f30.js";
const MAP_KEY = `sourcemaps/${SERVICE_VERSION}/assets/app-f30.js.map`;

// ---- the real minified bundle ---------------------------------------------

const require = createRequire(import.meta.url);
const VITE_BIN = path.join(
  path.dirname(require.resolve("vite/package.json", { paths: [new URL("../apps/authoring", import.meta.url).pathname] })),
  "bin",
  "vite.js",
);

// Line numbers are asserted below: `row!.type` is widget.ts line 2, the
// `rows.map(parseRow)` call is main.ts line 4. Two modules, so the map has
// two `src/` sources and the stack two resolvable bundle frames.
const WIDGET_SOURCE = `export function parseRow(row: { type: string } | null): string {
  return row!.type.toUpperCase();
}
`;
const MAIN_SOURCE = `import { parseRow } from "./widget";
export function handleEvent(input: unknown): string {
  const rows = [input as { type: string } | null];
  return rows.map(parseRow).join(",");
}
`;
// IIFE so the parent can run it with `vm.runInNewContext` under a
// production-shaped URL; `minify: true` so every frame is `:1:<col>`.
const VITE_CONFIG = `export default {
  logLevel: "silent",
  build: {
    outDir: "dist",
    sourcemap: "hidden",
    minify: true,
    lib: { entry: "./src/main.ts", formats: ["iife"], name: "F30Fixture", fileName: () => "app.js" },
  },
};
`;

async function buildBundle() {
  const dir = await mkdtemp(path.join(tmpdir(), "o11y-f30-bundle-"));
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "widget.ts"), WIDGET_SOURCE);
  await writeFile(path.join(dir, "src", "main.ts"), MAIN_SOURCE);
  await writeFile(path.join(dir, "vite.config.mjs"), VITE_CONFIG);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VITE_BIN, "build"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited ${code}:\n${log}`))));
  });
  return dir;
}

/** Runs the bundle under its production URL and returns the REAL V8 stack
 *  as Faro-shaped frames (bundle frames only; Node's own and this test
 *  file's frames are not part of a browser stack). */
function throwInsideBundle(code) {
  // A fresh context, so the bundle's top-level `var` never lands on (and
  // cannot be deleted from) this process's own global.
  const sandbox = {};
  vm.runInNewContext(code, sandbox, { filename: BUNDLE_URL });
  let error;
  try {
    sandbox.F30Fixture.handleEvent(null);
  } catch (err) {
    error = err;
  }
  assert.equal(error?.name, "TypeError", "the bundle must throw a real TypeError");
  const frames = [];
  for (const line of error.stack.split("\n").slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m || m[2] !== BUNDLE_URL) continue;
    frames.push({ function: m[1], filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return { error, frames };
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function runChild(workdir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disallow-code-generation-from-strings", "--experimental-strip-types", "--no-warnings", CHILD, workdir],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`drain child exited ${code}:\n${err}`));
      const line = out.trim().split("\n").at(-1);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`drain child printed no JSON result:\n${out}\n${err}`));
      }
    });
  });
}

test("a real minified bundle's exception is symbolicated by the real drain under workerd's no-code-generation policy", async () => {
  const dir = await buildBundle();
  try {
    const code = readFileSync(path.join(dir, "dist", "app.js"), "utf8");
    const mapText = readFileSync(path.join(dir, "dist", "app.js.map"), "utf8");
    const { error, frames } = throwInsideBundle(code);
    assert.ok(frames.length >= 2, `expected at least two bundle frames, got ${JSON.stringify(frames)}`);
    assert.ok(frames.every((f) => f.lineno === 1), "a minified bundle is one line; every bundle frame should be on line 1");

    // The same page-frame shape (`at eval (http://localhost:5391/:303:30)`).
    const pageFrame = { function: "eval", filename: "https://demos.handsontable.com/", lineno: 303, colno: 30 };

    // The ingest-side record exactly as the contract builds it: scrub, convert, pack.
    const scrubbed = scrubTelemetry({
      type: "exception",
      payload: {
        type: error.name,
        value: error.message,
        stacktrace: { frames: [...frames, pageFrame] },
        timestamp: new Date().toISOString(),
        context: {},
      },
      meta: {},
    });
    assert.ok(scrubbed, "the scrubber must keep an exception item");
    const record = faroItemToRecord(scrubbed, {
      service: { name: "demos-authoring", version: SERVICE_VERSION, environment: "production" },
      receivedAtMs: Date.now(),
    });
    const rawBody = record.body;
    assert.doesNotMatch(rawBody, /widget\.ts|main\.ts/, "before the drain the body must carry only minified frames");

    const workdir = await mkdtemp(path.join(tmpdir(), "o11y-f30-drain-"));
    try {
      const key = inboxKey("browser", new Date(), 0);
      await writeFile(path.join(workdir, "inbox-key.txt"), key);
      await writeFile(path.join(workdir, "inbox.ndjson.gz"), await gzip(encodeNdjson([buildResourceLogs(record)])));
      await mkdir(path.dirname(path.join(workdir, "maps", MAP_KEY)), { recursive: true });
      await writeFile(path.join(workdir, "maps", MAP_KEY), mapText);

      const out = await runChild(workdir);

      assert.equal(out.codegenBlocked, true, "the drain child must run with code generation from strings disallowed, as workerd does");
      assert.equal(out.result.stoppedEarly, false);
      assert.equal(out.result.outcomes[0].outcome, "provisional", JSON.stringify(out.result.outcomes));
      assert.deepEqual(out.mapReads, [MAP_KEY], "one read of the bundle's map; the page frame must not fetch `sourcemaps/<sha>/.map`");

      const pushedBody = out.pushes[0].body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue;
      assert.match(pushedBody, /^TypeError: Cannot read properties of null \(reading 'type'\)$/m);
      assert.match(pushedBody, /^ {4}at .+ \(src\/widget\.ts:2:\d+\)$/m, `the throwing frame must resolve to src/widget.ts:2, got:\n${pushedBody}`);
      assert.match(pushedBody, /^ {4}at .+ \(src\/main\.ts:4:\d+\)$/m, `the caller frame must resolve to src/main.ts:4, got:\n${pushedBody}`);
      assert.match(pushedBody, /^ {4}at eval \(https:\/\/demos\.handsontable\.com\/:303:30\)$/m, "the page frame is left exactly as rendered");
      assert.doesNotMatch(pushedBody, /app-f30\.js:1:/, "no bundle frame may stay minified");
      assert.doesNotMatch(pushedBody, /\.\.\//, "resolved sources are normalised, never `../`-relative");
      assert.deepEqual(out.skips, [], "every attempted frame resolved, so there is nothing to report");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- skip signal --------------------------------------------------------------

function exceptionRecord(frameLines, serviceVersion = "cafe1234") {
  return {
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "demos-authoring" } },
        { key: "service.version", value: { stringValue: serviceVersion } },
      ],
    },
    scopeLogs: [
      {
        logRecords: [
          {
            timeUnixNano: "1000000000",
            body: { stringValue: ["TypeError: x", ...frameLines].join("\n") },
            attributes: [{ key: "hot.kind", value: { stringValue: "exception" } }],
          },
        ],
      },
    ],
  };
}

function frame(file, lineno = 1, colno = 1) {
  return formatStackFrame({ filename: `https://demos.handsontable.com/assets/${file}`, function: "f", lineno, colno });
}

async function collectSkips(records, getMap, extraDeps = {}) {
  const calls = [];
  const out = await symbolicateResourceLogs(records, { getMap, ...extraDeps, onSkip: (skips, suppressed) => calls.push({ skips, suppressed }) });
  return { out, calls };
}

const ONE_MAPPING_MAP = JSON.stringify({ version: 3, sources: ["../../src/a.ts"], names: [], mappings: "AAAA" });

test("skip signal: an absent map is reported once per key, with the count of frames it left unresolved", async () => {
  const records = [exceptionRecord([frame("index-a.js", 1, 1), frame("index-a.js", 1, 9)]), exceptionRecord([frame("index-a.js", 1, 3)])];
  const { out, calls } = await collectSkips(records, async () => null);
  assert.deepEqual(out, records, "reporting must never change the output");
  assert.deepEqual(calls, [
    { skips: [{ key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "no_map", frames: 3 }], suppressed: 0 },
  ]);
});

test("skip signal: a map read that throws is `fetch_error`, not `no_map` (transient vs absent)", async () => {
  const { calls } = await collectSkips([exceptionRecord([frame("index-a.js")])], async () => {
    throw new Error("R2 get timed out");
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].skips, [
    { key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "fetch_error", frames: 1, detail: "Error: R2 get timed out" },
  ]);
});

test("skip signal: an unparseable map is `parse_error` with the parser's message", async () => {
  const { calls } = await collectSkips([exceptionRecord([frame("index-a.js")])], async () => "<!doctype html>");
  assert.equal(calls[0].skips[0].reason, "parse_error");
  assert.match(calls[0].skips[0].detail, /^SyntaxError: /);
});

test("skip signal: a lookup that throws inside the map library is `lookup_error` (the failure shape)", async () => {
  // A decoded-array `mappings` with a null segment: accepted by the
  // constructor, throws on the first lookup, like source-map-js's EvalError did.
  const poisoned = JSON.stringify({ version: 3, sources: ["../../src/a.ts"], names: [], mappings: [[null]] });
  const record = exceptionRecord([frame("index-a.js")]);
  const { out, calls } = await collectSkips([record], async () => poisoned);
  assert.deepEqual(out, [record]);
  assert.equal(calls[0].skips[0].reason, "lookup_error");
  assert.equal(calls[0].skips[0].frames, 1);
  assert.match(calls[0].skips[0].detail, /^TypeError: /);
});

test("skip signal: a map that loads but maps none of the frames is `no_frames_matched`", async () => {
  // The map's only mapping is line 1; the frame points at line 50.
  const { calls } = await collectSkips([exceptionRecord([frame("index-a.js", 50, 1)])], async () => ONE_MAPPING_MAP);
  assert.deepEqual(calls[0].skips, [{ key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "no_frames_matched", frames: 1 }]);
});

test("skip signal: nothing is reported when every attempted frame resolved, and Babel/page frames are never attempted", async () => {
  const record = exceptionRecord([
    frame("index-a.js", 1, 1),
    frame("babel-abc123.js", 1, 1),
    formatStackFrame({ filename: "https://demos.handsontable.com/", function: "eval", lineno: 303, colno: 30 }),
  ]);
  const reads = [];
  const { out, calls } = await collectSkips([record], async (key) => {
    reads.push(key);
    return ONE_MAPPING_MAP;
  });
  assert.match(out[0].scopeLogs[0].logRecords[0].body.stringValue, /\(src\/a\.ts:1:1\)/);
  assert.deepEqual(reads, ["sourcemaps/cafe1234/assets/index-a.js.map"]);
  assert.deepEqual(calls, []);
});

test("skip signal: bounded to MAX_SKIP_REPORTS keys per call, the rest counted", async () => {
  const lines = Array.from({ length: MAX_SKIP_REPORTS + 5 }, (_, i) => frame(`chunk-${i}.js`));
  const { calls } = await collectSkips([exceptionRecord(lines)], async () => null);
  assert.equal(calls.length, 1, "one report per call");
  assert.equal(calls[0].skips.length, MAX_SKIP_REPORTS);
  assert.equal(calls[0].suppressed, 5);
  assert.equal(new Set(calls[0].skips.map((s) => s.key)).size, MAX_SKIP_REPORTS, "at most one entry per key");
});

test("skip signal: a reporter that throws does not cost the resolved output", async () => {
  const record = exceptionRecord([frame("index-a.js", 1, 1), frame("index-b.js", 1, 1)]);
  const out = await symbolicateResourceLogs([record], {
    getMap: async (key) => (key.endsWith("index-a.js.map") ? ONE_MAPPING_MAP : null),
    onSkip: () => {
      throw new Error("logger down");
    },
  });
  assert.match(out[0].scopeLogs[0].logRecords[0].body.stringValue, /\(src\/a\.ts:1:1\)/);
});

test("skip signal: the default reporter writes one `o11y.symbolicate.skip` JSON line per key", async (t) => {
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(line));
  await symbolicateResourceLogs([exceptionRecord([frame("index-a.js")])], { getMap: async () => null });
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [
    { event: "o11y.symbolicate.skip", key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "no_map", frames: 1 },
  ]);
});

// ---- R2 read caps ---------------------------------------------------------------

/** One exception record per stack, stamped now so the drain's age filter keeps it. */
function recentExceptionRecord(frameLines, serviceVersion) {
  const record = exceptionRecord(frameLines, serviceVersion);
  record.scopeLogs[0].logRecords[0].timeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
  return record;
}

/** A body under the 1 MB collect cap: 5 exceptions of 2980 frames, each frame
 *  its own made-up chunk URL, so every frame is a distinct map key. */
function fanoutRecords(offset = 0) {
  let n = offset;
  return Array.from({ length: 5 }, () =>
    recentExceptionRecord(
      Array.from({ length: 2980 }, () => formatStackFrame({ filename: `http://a/${(n++).toString(36)}.js`, function: "f", lineno: 1, colno: 1 })),
      "x",
    ),
  );
}

const bodyOf = (record) => record.scopeLogs[0].logRecords[0].body.stringValue;

test("a fan-out body reads at most MAX_MAP_KEYS_PER_CALL maps in the real drain, and leaves every frame past the caps as it was", async () => {
  const records = fanoutRecords();
  const keyOf = (body, j) => `sourcemaps/x/${(body * 2980 + j).toString(36)}.js.map`;
  const bodiesWithBudget = MAX_MAP_KEYS_PER_CALL / MAX_NEW_MAP_KEYS_PER_BODY;
  const expectedReads = Array.from({ length: bodiesWithBudget }, (_, b) =>
    Array.from({ length: MAX_NEW_MAP_KEYS_PER_BODY }, (_, j) => keyOf(b, j)),
  ).flat();
  const workdir = await mkdtemp(path.join(tmpdir(), "o11y-fanout-drain-"));
  try {
    await writeFile(path.join(workdir, "inbox-key.txt"), inboxKey("browser", new Date(), 0));
    await writeFile(path.join(workdir, "inbox.ndjson.gz"), await gzip(encodeNdjson(records)));
    // Maps exist past the caps too, so a capped frame stays unresolved because it was never read.
    const pastCap = Array.from({ length: 8 }, (_, j) => keyOf(0, MAX_NEW_MAP_KEYS_PER_BODY + j));
    for (const key of [...expectedReads, ...pastCap]) {
      await mkdir(path.dirname(path.join(workdir, "maps", key)), { recursive: true });
      await writeFile(path.join(workdir, "maps", key), ONE_MAPPING_MAP);
    }

    const out = await runChild(workdir);

    assert.equal(out.codegenBlocked, true);
    assert.deepEqual(out.mapReads, expectedReads, "each body's first-seen keys, each read once");
    assert.equal(out.result.outcomes[0].outcome, "provisional", JSON.stringify(out.result.outcomes));
    const pushed = out.pushes.flatMap((p) => p.body.resourceLogs).map(bodyOf);
    const sent = records.map(bodyOf);
    assert.equal(pushed.length, sent.length);
    for (let b = 0; b < sent.length; b++) {
      const resolved = b < bodiesWithBudget ? MAX_NEW_MAP_KEYS_PER_BODY : 0;
      const pushedLines = pushed[b].split("\n");
      const sentLines = sent[b].split("\n");
      for (let i = 1; i <= resolved; i++) assert.match(pushedLines[i], /\(src\/a\.ts:1:1\)$/);
      assert.deepEqual(pushedLines.slice(resolved + 1), sentLines.slice(resolved + 1), `body ${b}: capped frames are byte-for-byte`);
    }
    const capped = sent.length * 2980 - MAX_MAP_KEYS_PER_CALL;
    assert.deepEqual(out.skips.map((s) => s.overCap), [{ frames: capped, keys: capped }]);
    const reported = out.skips.flatMap((s) => s.reported);
    assert.ok(reported.length > 0 && reported.every((s) => s.reason === "over_cap"), JSON.stringify(reported.slice(0, 3)));
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

test("a forged item packed before a real exception cannot use up the object's map budget, and the capped count is always reported", async (t) => {
  const forged = exceptionRecord(
    Array.from({ length: MAX_MAP_KEYS_PER_CALL }, (_, i) => formatStackFrame({ filename: `http://a/${i}.js`, function: "f", lineno: 1, colno: 1 })),
    "anything",
  );
  const real = exceptionRecord([frame("app.js", 1, 1)], "realsha");
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(JSON.parse(line)));

  const out = await symbolicateResourceLogs([forged, real], {
    getMap: async (key) => (key === "sourcemaps/realsha/assets/app.js.map" ? ONE_MAPPING_MAP : null),
  });

  assert.equal(bodyOf(out[1]).split("\n")[1], "    at f (src/a.ts:1:1)");
  const capped = MAX_MAP_KEYS_PER_CALL - MAX_NEW_MAP_KEYS_PER_BODY;
  assert.ok(lines.some((l) => l.reason === "suppressed"), "the per-key lines overflow MAX_SKIP_REPORTS");
  assert.deepEqual(lines.at(-1), { event: "o11y.symbolicate.skip", reason: "over_cap", frames: capped, keys: capped });
});

// ---- listing the version's maps before reading -----------------------------------

const forgedFrames = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => formatStackFrame({ filename: `http://a/${offset + i}.js`, function: "f", lineno: 1, colno: 1 }));

/** A `listMaps` over a fixed set of keys, recording the prefixes it was asked. */
function fakeBucket(keys) {
  const prefixes = [];
  return { prefixes, listMaps: async (prefix) => (prefixes.push(prefix), new Set(keys.filter((k) => k.startsWith(prefix)))) };
}

test("four forged bodies of forged paths cannot push a real exception later in the object over the map budget", async () => {
  const forged = Array.from({ length: 4 }, (_, i) => exceptionRecord(forgedFrames(MAX_NEW_MAP_KEYS_PER_BODY, i * 100), `forged${i}`));
  const real = exceptionRecord([frame("app.js", 1, 1)], "realsha");
  const realKey = "sourcemaps/realsha/assets/app.js.map";
  const reads = [];
  const { out, calls } = await collectSkips([...forged, real], null, {
    ...fakeBucket([realKey]),
    getMap: async (key) => (reads.push(key), key === realKey ? ONE_MAPPING_MAP : null),
  });

  assert.equal(bodyOf(out[4]).split("\n")[1], "    at f (src/a.ts:1:1)", "the real exception resolves");
  assert.deepEqual(reads, [realKey], "a forged path costs no read");
  assert.ok(calls[0].skips.every((s) => s.reason !== "over_cap"), JSON.stringify(calls[0].skips));
  assert.ok(calls[0].skips.some((s) => s.reason === "no_map" && s.key === "sourcemaps/forged0/0.js.map"));
});

test("a frame whose map the listing lacks is reported as no_map without a read", async () => {
  const reads = [];
  const { calls } = await collectSkips([exceptionRecord([frame("gone.js")])], null, {
    ...fakeBucket([]),
    getMap: async (key) => (reads.push(key), ONE_MAPPING_MAP),
  });
  assert.deepEqual(reads, []);
  assert.deepEqual(calls[0].skips, [{ key: "sourcemaps/cafe1234/assets/gone.js.map", reason: "no_map", frames: 1 }]);
});

test("listing runs once per distinct version, with that version's prefix", async () => {
  const bucket = fakeBucket(["sourcemaps/v1/assets/a.js.map"]);
  await collectSkips([exceptionRecord([frame("a.js")], "v1"), exceptionRecord([frame("a.js")], "v1"), exceptionRecord([frame("b.js")], "v2")], null, {
    ...bucket,
    getMap: async () => ONE_MAPPING_MAP,
  });
  assert.deepEqual(bucket.prefixes, ["sourcemaps/v1/", "sourcemaps/v2/"]);
});

test("a version with no resolvable frame is not listed", async () => {
  const bucket = fakeBucket([]);
  await collectSkips([exceptionRecord([], "v1"), exceptionRecord([frame("babel-abc.js")], "v2")], null, { ...bucket, getMap: async () => null });
  assert.deepEqual(bucket.prefixes, []);
});

test("more than MAX_LISTED_VERSIONS_PER_CALL distinct versions list only that many, and the rest are reported without a read", async () => {
  const total = MAX_LISTED_VERSIONS_PER_CALL + 3;
  const versions = Array.from({ length: total }, (_, i) => `v${i}`);
  const bucket = fakeBucket(versions.map((v) => `sourcemaps/${v}/assets/a.js.map`));
  const reads = [];
  const { out, calls } = await collectSkips(versions.map((v) => exceptionRecord([frame("a.js")], v)), null, {
    ...bucket,
    getMap: async (key) => (reads.push(key), ONE_MAPPING_MAP),
  });
  assert.deepEqual(bucket.prefixes, versions.slice(0, MAX_LISTED_VERSIONS_PER_CALL).map((v) => `sourcemaps/${v}/`));
  assert.equal(reads.length, MAX_LISTED_VERSIONS_PER_CALL);
  assert.equal(bodyOf(out[total - 1]).split("\n")[1], "    at f (https://demos.handsontable.com/assets/a.js:1:1)", "an unlisted version's frames stay as they were");
  const over = calls[0].skips.filter((s) => s.reason === "over_version_cap");
  assert.deepEqual(over.map((s) => [s.key, s.frames]), versions.slice(MAX_LISTED_VERSIONS_PER_CALL).map((v) => [`sourcemaps/${v}/`, 1]));
});

test("a listing that throws falls back to admitting by the caps, and is reported as list_error", async () => {
  const reads = [];
  const { out, calls } = await collectSkips([exceptionRecord([frame("app.js", 1, 1)])], null, {
    listMaps: async () => {
      throw new Error("R2 list timed out");
    },
    getMap: async (key) => (reads.push(key), ONE_MAPPING_MAP),
  });
  assert.deepEqual(reads, ["sourcemaps/cafe1234/assets/app.js.map"]);
  assert.equal(bodyOf(out[0]).split("\n")[1], "    at f (src/a.ts:1:1)");
  assert.deepEqual(calls[0].skips, [
    { key: "sourcemaps/cafe1234/", reason: "list_error", frames: 0, detail: "Error: R2 list timed out" },
  ]);
});

test("with listing on, the same frames resolve on every replay whatever order the reads answer in", async () => {
  const records = [recentExceptionRecord(Array.from({ length: 40 }, (_, i) => frame(`c${i}.js`)), "v"), recentExceptionRecord(forgedFrames(40), "v")];
  const keys = Array.from({ length: 40 }, (_, i) => `sourcemaps/v/assets/c${i}.js.map`);
  const outputs = [];
  for (const delay of [(i) => i, (i) => 40 - i]) {
    let i = 0;
    const out = await symbolicateResourceLogs(records, {
      ...fakeBucket(keys),
      getMap: async () => {
        await new Promise((r) => setTimeout(r, delay(i++ % 40)));
        return ONE_MAPPING_MAP;
      },
      onSkip() {},
    });
    outputs.push(JSON.stringify(out));
  }
  assert.equal(outputs[0], outputs[1]);
});

test("frames past MAX_FRAMES_PER_BODY in one body are left as they were and reported as over_cap", async () => {
  const lines = Array.from({ length: MAX_FRAMES_PER_BODY + 72 }, () => frame("index-a.js", 1, 1));
  const record = exceptionRecord(lines);
  const reads = [];
  const { out, calls } = await collectSkips([record], async (key) => {
    reads.push(key);
    return ONE_MAPPING_MAP;
  });
  const outLines = out[0].scopeLogs[0].logRecords[0].body.stringValue.split("\n");
  assert.deepEqual(reads, ["sourcemaps/cafe1234/assets/index-a.js.map"]);
  assert.equal(outLines.filter((l) => l.endsWith("(src/a.ts:1:1)")).length, MAX_FRAMES_PER_BODY);
  assert.deepEqual(outLines.slice(MAX_FRAMES_PER_BODY + 1), lines.slice(MAX_FRAMES_PER_BODY));
  assert.deepEqual(calls, [{ skips: [{ key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "over_cap", frames: 72 }], suppressed: 0 }]);
});

test("the caps make the same frames resolve on every replay, whatever order the map reads answer in", async () => {
  const records = [recentExceptionRecord(Array.from({ length: 40 }, (_, i) => frame(`c${i}.js`)), "v"), recentExceptionRecord(Array.from({ length: 40 }, (_, i) => frame(`d${i}.js`)), "v")];
  const outputs = [];
  for (const delay of [(i) => i, (i) => 40 - i]) {
    let i = 0;
    const out = await symbolicateResourceLogs(records, {
      getMap: async () => {
        await new Promise((r) => setTimeout(r, delay(i++ % 40)));
        return ONE_MAPPING_MAP;
      },
      onSkip() {},
    });
    outputs.push(JSON.stringify(out));
  }
  assert.equal(outputs[0], outputs[1]);
});

test("a full drain batch of fan-out keys reads at most 10 × MAX_MAP_KEYS_PER_CALL maps in total", async () => {
  const objects = new Map();
  for (let k = 0; k < 10; k++) objects.set(inboxKey("browser", new Date(), k), await gzip(encodeNdjson(fanoutRecords(k * 14_900))));
  let reads = 0;
  const result = await drainBatch([...objects.keys()], new Set(), {
    fetchObject: async (key) => objects.get(key) ?? null,
    pushToLoki: async () => ({ status: 204 }),
    symbolicate: (records) =>
      symbolicateResourceLogs(records, {
        getMap: async () => {
          reads++;
          return null;
        },
        onSkip() {},
      }),
  });
  assert.deepEqual(new Set(result.outcomes.map((o) => o.outcome)), new Set(["provisional"]));
  assert.equal(reads, 10 * MAX_MAP_KEYS_PER_CALL);
});

// ---- source-path normalisation -----------------------------------------------

test("normaliseSourcePath: a CI build's map-relative sources read as src/… and packages/…", () => {
  assert.equal(normaliseSourcePath("../../src/sentry.ts"), "src/sentry.ts");
  assert.equal(normaliseSourcePath("../../../../packages/runtime/dist/monitor.js"), "packages/runtime/dist/monitor.js");
  assert.equal(
    normaliseSourcePath("../../../../node_modules/.pnpm/@sentry+browser@10.68.0/node_modules/@sentry/browser/build/npm/esm/prod/helpers.js"),
    "node_modules/.pnpm/@sentry+browser@10.68.0/node_modules/@sentry/browser/build/npm/esm/prod/helpers.js",
  );
  assert.equal(normaliseSourcePath("./src/App.tsx"), "src/App.tsx");
});

test("normaliseSourcePath: a build outside the checkout never leaks the home directory", () => {
  assert.equal(
    normaliseSourcePath("../../../../../../../../Users/someone/Code/examples/runner/packages/runtime/dist/monitor.js"),
    "packages/runtime/dist/monitor.js",
  );
  assert.equal(
    normaliseSourcePath("../../../../../../../../Users/someone/Code/examples/runner/apps/authoring/src/sentry.ts"),
    "apps/authoring/src/sentry.ts",
  );
  // GitHub Actions: the CI user is also called `runner`; the repo's own `runner/` wins.
  assert.equal(
    normaliseSourcePath("/home/runner/work/examples/examples/runner/apps/authoring/src/main.tsx"),
    "apps/authoring/src/main.tsx",
  );
  assert.equal(normaliseSourcePath("file:///home/runner/work/examples/examples/runner/packages/x.ts"), "packages/x.ts");
});

test("normaliseSourcePath: URL sources and app directories named like a workspace root are left alone", () => {
  assert.equal(normaliseSourcePath("https://cdn.jsdelivr.net/npm/handsontable/dist/x.js"), "https://cdn.jsdelivr.net/npm/handsontable/dist/x.js");
  assert.equal(normaliseSourcePath("../../src/packages/editor.ts"), "src/packages/editor.ts");
});
