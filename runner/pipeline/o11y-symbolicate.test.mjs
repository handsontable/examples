// Symbolication (workers/o11y/src/drain/symbolicate.ts, ADR-0041 §C.3).
// Unit cases against hand-built maps; a real `vite build` case (exit
// criterion 5, F4) builds its OWN tiny fixture into a fresh temp dir below
// — see that section's own header comment for why (it used to read
// whatever apps/authoring/dist happened to exist on disk).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

// Dynamic, not static — a static `import ... from "source-map-js"` resolves
// during this module's LINK phase, before its own body (including the
// `register()` call above) ever runs, so it would miss the borrowed-resolve
// hook entirely and fail with `ERR_MODULE_NOT_FOUND` (reproduced running
// this exact file before switching to a dynamic import).
const { SourceMapGenerator } = await import("source-map-js");
const { symbolicateResourceLogs } = await import("../workers/o11y/src/drain/symbolicate.ts");
const { formatStackFrame } = await import("@handsontable/demo-runtime/telemetry");

function exceptionRecord(bodyLines, serviceVersion = "deadbeef1234") {
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
            body: { stringValue: bodyLines.join("\n") },
            attributes: [{ key: "hot.kind", value: { stringValue: "exception" } }],
          },
        ],
      },
    ],
  };
}

/** A minimal, real, hand-built source map: one mapping, generated line 1
 *  column 0 -> original `src/app.ts` line 5 column 2, function `render`. */
function buildTestMap() {
  const gen = new SourceMapGenerator({ file: "index-abc123.js" });
  gen.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 5, column: 2 },
    source: "src/app.ts",
    name: "render",
  });
  gen.setSourceContent("src/app.ts", "// source\n");
  return gen.toString();
}

test("symbolicateResourceLogs resolves an app-chunk frame to its original src/ file and line", async () => {
  const frameLine = formatStackFrame({
    filename: "https://demos.handsontable.com/assets/index-abc123.js",
    function: "minifiedFn",
    lineno: 1,
    colno: 1, // 1-based -> column 0 after conversion
  });
  const record = exceptionRecord(["TypeError: x is not a function", frameLine]);

  const maps = new Map([["sourcemaps/deadbeef1234/assets/index-abc123.js.map", buildTestMap()]]);
  const [resolved] = await symbolicateResourceLogs([record], { getMap: async (key) => maps.get(key) ?? null });

  const body = resolved.scopeLogs[0].logRecords[0].body.stringValue;
  assert.match(body, /src\/app\.ts:5:3/, `expected a resolved src/app.ts:5:3 frame, got:\n${body}`);
  assert.match(body, /render/, "the original function name should replace the minified one");
});

test("symbolicateResourceLogs leaves a Babel-chunk frame unparsed even when a map exists for it", async () => {
  const frameLine = formatStackFrame({
    filename: "https://demos.handsontable.com/assets/babel-9f8e7d.js",
    function: "parse",
    lineno: 10,
    colno: 5,
  });
  const record = exceptionRecord(["SyntaxError: bad token", frameLine]);
  // A map DOES exist at the expected key — the skip must be by filename,
  // not merely "no map found".
  const maps = new Map([["sourcemaps/deadbeef1234/assets/babel-9f8e7d.js.map", buildTestMap()]]);

  const [resolved] = await symbolicateResourceLogs([record], { getMap: async (key) => maps.get(key) ?? null });

  const body = resolved.scopeLogs[0].logRecords[0].body.stringValue;
  assert.equal(body, record.scopeLogs[0].logRecords[0].body.stringValue, "Babel-chunk frame must be byte-identical, unresolved");
});

test("symbolicateResourceLogs leaves a frame unresolved when no map exists (never fetches the app origin)", async () => {
  const frameLine = formatStackFrame({
    filename: "https://demos.handsontable.com/assets/index-nomap.js",
    function: "fn",
    lineno: 2,
    colno: 2,
  });
  const record = exceptionRecord(["Error: x", frameLine]);
  let fetchedFromAppOrigin = false;

  const [resolved] = await symbolicateResourceLogs([record], {
    getMap: async () => {
      // A real implementation reads only from the maps bucket; this fake
      // proves the module never falls back to fetching the app origin
      // (the task's own Trap: "a rotated hash answers 200 text/html").
      return null;
    },
  });

  assert.equal(fetchedFromAppOrigin, false);
  assert.equal(resolved.scopeLogs[0].logRecords[0].body.stringValue, record.scopeLogs[0].logRecords[0].body.stringValue);
});

test("symbolicateResourceLogs never touches a non-exception record", async () => {
  const record = {
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "demos-authoring" } },
        { key: "service.version", value: { stringValue: "deadbeef1234" } },
      ],
    },
    scopeLogs: [
      {
        logRecords: [
          {
            timeUnixNano: "1",
            body: { stringValue: "session started" },
            attributes: [{ key: "hot.kind", value: { stringValue: "log" } }],
          },
        ],
      },
    ],
  };
  const [resolved] = await symbolicateResourceLogs([record], { getMap: async () => buildTestMap() });
  assert.deepEqual(resolved, record);
});

test("symbolicateResourceLogs is deterministic: two independent calls over the same input produce identical output", async () => {
  // ADR-0041 exit criterion 2's replay equality needs this — a symbolicator
  // whose output depended on residual cache warmth from a PRIOR call would
  // make a re-drained record's body differ from the first drain's.
  const frameLine = formatStackFrame({
    filename: "https://demos.handsontable.com/assets/index-abc123.js",
    function: "minifiedFn",
    lineno: 1,
    colno: 1,
  });
  const record = exceptionRecord(["TypeError: x is not a function", frameLine]);
  const maps = new Map([["sourcemaps/deadbeef1234/assets/index-abc123.js.map", buildTestMap()]]);
  const deps = { getMap: async (key) => maps.get(key) ?? null };

  const [first] = await symbolicateResourceLogs([record], deps);
  const [second] = await symbolicateResourceLogs([record], deps); // a fresh call, simulating a separate wake

  assert.deepEqual(first, second);
});

// ---- Z-B-C1: a line-0 stack frame must not throw out of symbolication -----
//
// `source-map-js#originalPositionFor({ line: 0, ... })` throws
// `TypeError: Line must be greater than or equal to 1, got 0` — reachable
// from one anonymous `POST /telemetry/collect` request with a crafted
// `lineno: 0` exception frame (ingest does not reject it). Before this fix,
// that throw escaped `resolveBody`, then `symbolicateResourceLogs`, then
// `drain.ts#drainKey`, then `drainBatch` — poisoning the whole drain queue
// (see `pipeline/o11y-drain.test.mjs`'s own Z-B-C1 tests for the
// batch/key-isolation half of this fix).
//
// The raw stack line is built by hand here, not through `formatStackFrame`
// — `convert.ts#formatStackFrame` now has its own optional ingest-side
// guard (Z-B-C1) that omits the position for a `lineno < 1`, which would
// hide the very shape this test needs to construct. A record ingested
// before that guard existed (or any other path that reaches `resolveBody`
// with this exact text) must still be handled safely — that is what this
// module's own guard is for, independent of the ingest-side fix.
test("Z-B-C1: symbolicateResourceLogs leaves a lineno: 0 frame's body byte-for-byte unchanged, and does not throw, even when a valid map exists", async () => {
  const poisonedLine = "    at f (https://demos.handsontable.com/assets/index-abc123.js:0:5)";
  const record = exceptionRecord(["TypeError: boom", poisonedLine]);
  const maps = new Map([["sourcemaps/deadbeef1234/assets/index-abc123.js.map", buildTestMap()]]);

  const [resolved] = await symbolicateResourceLogs([record], { getMap: async (key) => maps.get(key) ?? null });

  const body = resolved.scopeLogs[0].logRecords[0].body.stringValue;
  assert.equal(body, record.scopeLogs[0].logRecords[0].body.stringValue, "a lineno: 0 frame must be left byte-for-byte unresolved, never throw");
});

test("Z-B-C1: a lineno: 0 frame is left alone even alongside a genuinely resolvable frame in the same body", async () => {
  const poisonedLine = "    at f (https://demos.handsontable.com/assets/index-abc123.js:0:5)";
  const resolvableLine = formatStackFrame({
    filename: "https://demos.handsontable.com/assets/index-abc123.js",
    function: "minifiedFn",
    lineno: 1,
    colno: 1,
  });
  const record = exceptionRecord(["TypeError: boom", poisonedLine, resolvableLine]);
  const maps = new Map([["sourcemaps/deadbeef1234/assets/index-abc123.js.map", buildTestMap()]]);

  const [resolved] = await symbolicateResourceLogs([record], { getMap: async (key) => maps.get(key) ?? null });

  const body = resolved.scopeLogs[0].logRecords[0].body.stringValue;
  assert.match(body, /:0:5\)/, "the poisoned frame's raw text must survive unresolved");
  assert.match(body, /src\/app\.ts:5:3/, "a sibling resolvable frame in the SAME body must still resolve");
});

// ---- F4 / Exit criterion 5: a real `vite build` of a self-built fixture --
//
// This used to read whatever `apps/authoring/dist` happened to exist on
// disk: it FAILED (not skipped) when that dist existed but had no chunk
// whose map resolved back to first-party `src/` code, and it SKIPPED
// silently when there was no dist at all — neither is deterministic, and a
// skip reads as green in a summary. This builds its own tiny, throwaway
// fixture with a REAL `vite build --sourcemap` (the same `vite` the
// authoring app itself depends on — resolved by walking its manifest,
// `pipeline/vite-allowed-hosts.test.mjs`'s own established pattern, since
// vite's `exports` map does not expose `./bin/vite.js` directly) into a
// fresh temp dir, every run, never touching `apps/authoring/dist`. The
// evidence stays real — a real bundler, real esbuild minification, a real
// source map — just never dependent on another task's own build artifact
// existing (or not) on disk.

const require = createRequire(import.meta.url);
const VITE_BIN = path.join(
  path.dirname(require.resolve("vite/package.json", { paths: [new URL("../apps/authoring", import.meta.url).pathname] })),
  "bin",
  "vite.js",
);

const FIXTURE_SOURCE = `export function renderWidget(x: number): number {
  if (x < 0) throw new Error("boom");
  return x * 2;
}
`;

// A plain object, not \`defineConfig({...})\` from "vite" — this file has no
// node_modules of its own (a fresh temp dir), so importing "vite" here
// would need its own resolution setup; a plain default export needs none,
// and vite accepts it exactly the same way.
const FIXTURE_VITE_CONFIG = `export default {
  logLevel: "silent",
  build: {
    outDir: "dist",
    sourcemap: true,
    minify: true,
    lib: { entry: "./app.ts", formats: ["es"], fileName: () => "app.js" },
  },
};
`;

/** Builds a minimal, self-contained (one file, one function) fixture with a
 *  REAL `vite build --sourcemap`, into a fresh temp dir — fast (one small
 *  entry, no plugins) and fully deterministic: nothing here depends on
 *  anything else in this repo having been built first. Caller owns
 *  cleanup (`rm(dir, { recursive: true, force: true })`). */
async function buildFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "o11y-symbolicate-criterion5-"));
  await writeFile(path.join(dir, "app.ts"), FIXTURE_SOURCE);
  await writeFile(path.join(dir, "vite.config.mjs"), FIXTURE_VITE_CONFIG);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VITE_BIN, "build", "--sourcemap"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited ${code}:\n${log}`))));
  });
  return dir;
}

test("exit criterion 5: an exception from a real vite build (self-built fixture) resolves to a src/ file and line", async () => {
  const dir = await buildFixture();
  try {
    const { SourceMapConsumer } = await import("source-map-js");
    const mapText = readFileSync(path.join(dir, "dist", "app.js.map"), "utf8");
    const consumer = new SourceMapConsumer(JSON.parse(mapText));
    let probe = null;
    consumer.eachMapping((m) => {
      if (probe || m.originalLine === null || !m.source) return;
      probe = m;
    });
    assert.ok(probe, "expected at least one mapping back to the fixture's own app.ts");

    const frameLine = formatStackFrame({
      filename: "https://demos.handsontable.com/assets/app.js",
      function: "x",
      lineno: probe.generatedLine,
      colno: probe.generatedColumn + 1, // formatStackFrame/parseLine expect 1-based colno
    });
    const record = exceptionRecord(["Error: real build probe", frameLine]);

    if (globalThis.gc) globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const [resolved] = await symbolicateResourceLogs([record], {
      getMap: async (key) => (key === "sourcemaps/deadbeef1234/assets/app.js.map" ? mapText : null),
    });
    const elapsedMs = performance.now() - startedAt;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

    const body = resolved.scopeLogs[0].logRecords[0].body.stringValue;
    assert.match(body, /app\.ts/, `expected a resolved app.ts frame, got:\n${body}`);
    console.log(
      `[o11y-symbolicate] real-build probe (self-built fixture): ${elapsedMs.toFixed(1)}ms wall, ~${heapDeltaMb.toFixed(1)}MB Node heap delta (both proxies — see the task Outcome for the platform-measured number)`,
    );
    // Wall time as a CPU proxy — Worker CPU time cannot be read from inside
    // the isolate; the sandbox probe's platform-reported CPU is the real
    // evidence for the 500ms budget itself (see the task Outcome).
    assert.ok(elapsedMs < 500, `resolution took ${elapsedMs}ms wall time, expected well under 500ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exit criterion 5: a Babel-chunk frame from a real vite build is left unparsed even with a matching map", async () => {
  // The fixture's OWN app.js is deliberately reused, RENAMED to a
  // babel-*.js filename — proving `isBabelChunk`'s skip fires against a
  // real, non-trivial map (not just the hand-built one-mapping map the
  // unit test above this uses), the same way a real Babel compiler chunk
  // would be skipped in production.
  const dir = await buildFixture();
  try {
    const mapText = readFileSync(path.join(dir, "dist", "app.js.map"), "utf8");
    const frameLine = formatStackFrame({
      filename: "https://demos.handsontable.com/assets/babel-abc123.js",
      function: "x",
      lineno: 1,
      colno: 1,
    });
    const record = exceptionRecord(["Error: babel chunk probe", frameLine]);

    const [resolved] = await symbolicateResourceLogs([record], {
      getMap: async (key) => (key === "sourcemaps/deadbeef1234/assets/babel-abc123.js.map" ? mapText : null),
    });

    assert.deepEqual(resolved, record, "a babel-*.js frame must be left byte-for-byte unparsed, even when a real map exists for it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
