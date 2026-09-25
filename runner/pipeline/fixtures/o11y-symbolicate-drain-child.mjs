// Child process for `pipeline/o11y-symbolicate-drain.test.mjs` (F30).
//
// The parent spawns this with `--disallow-code-generation-from-strings`, the
// V8 policy workerd applies to every Worker (`eval` / `new Function` throw
// `EvalError: Code generation from strings disallowed for this context`).
// A `node --test` file cannot set that flag for itself, and without it Node
// happily runs a map library that generates code, which is how F30 shipped
// green: every symbolication test passed in Node while every lookup in the
// real Worker threw.
//
// Runs the REAL `drain.ts#drainBatch` with the REAL
// `symbolicate.ts#symbolicateResourceLogs` over one gzipped inbox object the
// parent wrote, and prints one JSON line to stdout: whether code generation
// really was blocked in this process, the batch outcome, the decoded Loki
// push bodies, and every skip report `onSkip` received.
//
// argv: <workdir>  (holds `inbox.ndjson.gz`, `inbox-key.txt` and `maps/<key>`)

import { register } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

register("./o11y-worker-hooks.mjs", import.meta.url);

const workdir = process.argv[2];
if (!workdir) throw new Error("usage: o11y-symbolicate-drain-child.mjs <workdir>");

let codegenBlocked = false;
try {
  new Function("return 1");
} catch (err) {
  codegenBlocked = err instanceof EvalError;
}

const { drainBatch } = await import("../../workers/o11y/src/drain/drain.ts");
const { symbolicateResourceLogs } = await import("../../workers/o11y/src/drain/symbolicate.ts");

const inboxKey = readFileSync(path.join(workdir, "inbox-key.txt"), "utf8").trim();
const inboxObject = new Uint8Array(readFileSync(path.join(workdir, "inbox.ndjson.gz")));

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

const pushes = [];
const skips = [];
const mapReads = [];
const result = await drainBatch([inboxKey], new Set(), {
  fetchObject: async (key) => (key === inboxKey ? inboxObject : null),
  pushToLoki: async (tenant, gzippedBody) => {
    pushes.push({ tenant, body: JSON.parse(await gunzip(gzippedBody)) });
    return { status: 204 };
  },
  symbolicate: (records) =>
    symbolicateResourceLogs(records, {
      getMap: async (key) => {
        mapReads.push(key);
        const file = path.join(workdir, "maps", key);
        return existsSync(file) ? readFileSync(file, "utf8") : null;
      },
      onSkip: (reported, suppressed) => skips.push({ reported, suppressed }),
    }),
});

process.stdout.write(`${JSON.stringify({ codegenBlocked, result, pushes, skips, mapReads })}\n`);
