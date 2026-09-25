// F30 — drain-time symbolication inside a Workers-shaped runtime
// (workers/o11y/src/drain/symbolicate.ts, ADR-0041 §C.3, exit criterion 5).
//
// What F30 was: `source-map-js` builds a sort with `new Function(...)` on
// the first lookup. workerd forbids code generation from strings, so every
// lookup threw inside the real Worker, the per-frame catch swallowed it, and
// no production frame was ever resolved. Every Node test passed, because
// Node allows `new Function`.
//
// The first test here therefore runs the REAL drain (`drainBatch` with the
// REAL `symbolicateResourceLogs`) in a child Node process started with
// `--disallow-code-generation-from-strings`, the same V8 policy workerd
// applies, over a REAL minified `vite build` bundle and its REAL map. The
// child also reports whether code generation really was blocked, so the
// test cannot pass by quietly running without the policy.
//
// The rest cover the F30 skip signal (`onSkip`) and render-time source-path
// normalisation (`normaliseSourcePath`).
//
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

const { symbolicateResourceLogs, normaliseSourcePath, MAX_SKIP_REPORTS } = await import(
  "../workers/o11y/src/drain/symbolicate.ts"
);
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

test("F30: a real minified bundle's exception is symbolicated by the real drain under workerd's no-code-generation policy", async () => {
  const dir = await buildBundle();
  try {
    const code = readFileSync(path.join(dir, "dist", "app.js"), "utf8");
    const mapText = readFileSync(path.join(dir, "dist", "app.js.map"), "utf8");
    const { error, frames } = throwInsideBundle(code);
    assert.ok(frames.length >= 2, `expected at least two bundle frames, got ${JSON.stringify(frames)}`);
    assert.ok(frames.every((f) => f.lineno === 1), "a minified bundle is one line; every bundle frame should be on line 1");

    // The same page-frame shape F30's stack carried (`at eval (http://localhost:5391/:303:30)`).
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

// ---- F30 skip signal -------------------------------------------------------

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

async function collectSkips(records, getMap) {
  const calls = [];
  const out = await symbolicateResourceLogs(records, { getMap, onSkip: (skips, suppressed) => calls.push({ skips, suppressed }) });
  return { out, calls };
}

const ONE_MAPPING_MAP = JSON.stringify({ version: 3, sources: ["../../src/a.ts"], names: [], mappings: "AAAA" });

test("F30 skip signal: an absent map is reported once per key, with the count of frames it left unresolved", async () => {
  const records = [exceptionRecord([frame("index-a.js", 1, 1), frame("index-a.js", 1, 9)]), exceptionRecord([frame("index-a.js", 1, 3)])];
  const { out, calls } = await collectSkips(records, async () => null);
  assert.deepEqual(out, records, "reporting must never change the output");
  assert.deepEqual(calls, [
    { skips: [{ key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "no_map", frames: 3 }], suppressed: 0 },
  ]);
});

test("F30 skip signal: a map read that throws is `fetch_error`, not `no_map` (B-M6 transient vs absent)", async () => {
  const { calls } = await collectSkips([exceptionRecord([frame("index-a.js")])], async () => {
    throw new Error("R2 get timed out");
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].skips, [
    { key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "fetch_error", frames: 1, detail: "Error: R2 get timed out" },
  ]);
});

test("F30 skip signal: an unparseable map is `parse_error` with the parser's message", async () => {
  const { calls } = await collectSkips([exceptionRecord([frame("index-a.js")])], async () => "<!doctype html>");
  assert.equal(calls[0].skips[0].reason, "parse_error");
  assert.match(calls[0].skips[0].detail, /^SyntaxError: /);
});

test("F30 skip signal: a lookup that throws inside the map library is `lookup_error` (the F30 failure shape)", async () => {
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

test("F30 skip signal: a map that loads but maps none of the frames is `no_frames_matched`", async () => {
  // The map's only mapping is line 1; the frame points at line 50.
  const { calls } = await collectSkips([exceptionRecord([frame("index-a.js", 50, 1)])], async () => ONE_MAPPING_MAP);
  assert.deepEqual(calls[0].skips, [{ key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "no_frames_matched", frames: 1 }]);
});

test("F30 skip signal: nothing is reported when every attempted frame resolved, and Babel/page frames are never attempted", async () => {
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

test("F30 skip signal: bounded to MAX_SKIP_REPORTS keys per call, the rest counted", async () => {
  const lines = Array.from({ length: MAX_SKIP_REPORTS + 5 }, (_, i) => frame(`chunk-${i}.js`));
  const { calls } = await collectSkips([exceptionRecord(lines)], async () => null);
  assert.equal(calls.length, 1, "one report per call");
  assert.equal(calls[0].skips.length, MAX_SKIP_REPORTS);
  assert.equal(calls[0].suppressed, 5);
  assert.equal(new Set(calls[0].skips.map((s) => s.key)).size, MAX_SKIP_REPORTS, "at most one entry per key");
});

test("F30 skip signal: a reporter that throws does not cost the resolved output", async () => {
  const record = exceptionRecord([frame("index-a.js", 1, 1), frame("index-b.js", 1, 1)]);
  const out = await symbolicateResourceLogs([record], {
    getMap: async (key) => (key.endsWith("index-a.js.map") ? ONE_MAPPING_MAP : null),
    onSkip: () => {
      throw new Error("logger down");
    },
  });
  assert.match(out[0].scopeLogs[0].logRecords[0].body.stringValue, /\(src\/a\.ts:1:1\)/);
});

test("F30 skip signal: the default reporter writes one `o11y.symbolicate.skip` JSON line per key", async (t) => {
  const lines = [];
  t.mock.method(console, "warn", (line) => lines.push(line));
  await symbolicateResourceLogs([exceptionRecord([frame("index-a.js")])], { getMap: async () => null });
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [
    { event: "o11y.symbolicate.skip", key: "sourcemaps/cafe1234/assets/index-a.js.map", reason: "no_map", frames: 1 },
  ]);
});

// ---- F30 source-path normalisation ----------------------------------------

test("F30 normaliseSourcePath: a CI build's map-relative sources read as src/… and packages/…", () => {
  assert.equal(normaliseSourcePath("../../src/sentry.ts"), "src/sentry.ts");
  assert.equal(normaliseSourcePath("../../../../packages/runtime/dist/monitor.js"), "packages/runtime/dist/monitor.js");
  assert.equal(
    normaliseSourcePath("../../../../node_modules/.pnpm/@sentry+browser@10.68.0/node_modules/@sentry/browser/build/npm/esm/prod/helpers.js"),
    "node_modules/.pnpm/@sentry+browser@10.68.0/node_modules/@sentry/browser/build/npm/esm/prod/helpers.js",
  );
  assert.equal(normaliseSourcePath("./src/App.tsx"), "src/App.tsx");
});

test("F30 normaliseSourcePath: a build outside the checkout never leaks the home directory", () => {
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

test("F30 normaliseSourcePath: URL sources and app directories named like a workspace root are left alone", () => {
  assert.equal(normaliseSourcePath("https://cdn.jsdelivr.net/npm/handsontable/dist/x.js"), "https://cdn.jsdelivr.net/npm/handsontable/dist/x.js");
  assert.equal(normaliseSourcePath("../../src/packages/editor.ts"), "src/packages/editor.ts");
});
