// ADR §C.3 — symbolication in the Worker, at drain, for exception records
// only. `convert.ts#faroBody` (T03 addition) renders a Faro exception's
// stack as plain text in the record body, standard V8 shape:
//
//   TypeError: x is not a function
//       at fn (https://demos.handsontable.com/assets/index-abc123.js:12:34)
//
// This module parses that text back into frames, resolves app-chunk frames
// with `source-map-js` against `sourcemaps/<service.version>/<original
// asset path>.map` (the maps bucket), and rewrites resolved lines in place.
// Frames it cannot or must not resolve (Babel-chunk, third-party, a missing
// or unparseable map) are left byte-for-byte as rendered — never a
// placeholder, never a partial guess — so drain-time symbolication produces
// the exact same body text on every replay of the same source record
// (exit criterion 2's "a log query equals a single clean replay" needs
// this: a body that could come out differently on a re-drain after an
// unclean stop would make the replay's line diverge from a clean run's).

import { ATTR_HOT_KIND, type OtlpResourceLogs } from "@handsontable/demo-runtime/telemetry";
import { SourceMapConsumer, type RawSourceMap } from "source-map-js";

/** Exactly `convert.ts#formatStackFrame`'s output shape, parsed back out.
 *  `(?:` filename `(?::` line `:` col `)?)` — the position suffix is
 *  optional because `formatStackFrame` omits it when either coordinate was
 *  missing. Filename is greedy-but-bounded: everything up to the LAST
 *  `:<digits>:<digits>` before the closing paren, so a filename that itself
 *  contains a colon (a URL's own `https:`) is not mis-split — matched by
 *  anchoring the position group to the end of the line instead of using a
 *  narrow character class for the filename. */
const STACK_LINE_RE = /^( {4}at )(.+?) \((.+?)(?::(\d+):(\d+))?\)$/;

interface ParsedFrame {
  prefix: string;
  fn: string;
  filename: string;
  line?: number;
  col?: number;
}

function parseLine(line: string): ParsedFrame | null {
  const m = STACK_LINE_RE.exec(line);
  if (!m) return null;
  const [, prefix, fn, filename, lineStr, colStr] = m;
  if (prefix === undefined || fn === undefined || filename === undefined) return null;
  return {
    prefix,
    fn,
    filename,
    line: lineStr !== undefined ? Number(lineStr) : undefined,
    col: colStr !== undefined ? Number(colStr) : undefined,
  };
}

function renderLine(frame: ParsedFrame): string {
  const position = frame.line !== undefined && frame.col !== undefined ? `:${frame.line}:${frame.col}` : "";
  return `${frame.prefix}${frame.fn} (${frame.filename}${position})`;
}

/** Chunks CI names for its Babel compiler bundle with a `babel-` filename
 *  prefix (confirmed real convention in this codebase's Vite output — see
 *  the DEV-2569 fix, "Workers Assets answers a deploy-rotated
 *  `babel-<hash>.js`"). Criterion 5 requires these frames be "left
 *  unparsed," not merely unresolved because no map happens to exist for
 *  them — an explicit skip, checked before ever attempting a map fetch, is
 *  what makes that true regardless of whether CI someday uploads a map for
 *  every chunk including this one. */
function isBabelChunk(filename: string): boolean {
  try {
    const path = new URL(filename).pathname;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return /^babel-[\w.-]+\.js$/i.test(base);
  } catch {
    return /(?:^|\/)babel-[\w.-]+\.js$/i.test(filename);
  }
}

/** `sourcemaps/<service.version>/<original asset path>.map` (ADR §C.3). The
 *  frame's `filename` already went through `redactPreviewHosts` +
 *  `stripQueryAndFragment` at scrub time (a preview-host frame reads as a
 *  literal `<preview>` host and never resolves to a real map — correctly
 *  left unresolved, not a bug this function needs to special-case). `null`
 *  when `filename` is not a parseable URL at all. */
function mapKeyFor(filename: string, serviceVersion: string): string | null {
  try {
    const url = new URL(filename);
    return `sourcemaps/${serviceVersion}${url.pathname}.map`;
  } catch {
    return null;
  }
}

export interface SymbolicateDeps {
  /** Reads one map object; `null` when absent (never fetches from the app
   *  origin — the task's own Trap: "a rotated hash answers `200 text/html`"
   *  is exactly why this must be the maps bucket, never a `fetch()` to
   *  `demos.handsontable.com`). */
  getMap(key: string): Promise<string | null>;
}

/**
 * Per-invocation only (never a module-level/global cache): a symbolicator
 * whose result could depend on residual isolate warmth from an earlier,
 * possibly-interrupted drain attempt would make exit criterion 2's replay
 * non-deterministic — a map that happened to already be parsed (or not) on
 * a prior crashed wake must never change this wake's output. Lazy per-file
 * parse within this one call (ADR §C.3), discarded when it returns.
 */
class DrainMapCache {
  #parsed = new Map<string, SourceMapConsumer | null>();
  #parsedBytes = 0;
  /** A generous per-invocation ceiling on total parsed map JSON, well under
   *  the 64 MB isolate-memory budget criterion 5 sets for ONE exception's
   *  resolution — this is a batch-wide safety cap against a pathological
   *  object with many distinct chunk files, not the per-record budget
   *  itself (T03-D: exit criterion 5's own number is measured directly
   *  against a single real exception, see the task Outcome). */
  static readonly MAX_PARSED_BYTES = 48 * 1024 * 1024;

  readonly #deps: SymbolicateDeps;

  // A plain field assignment, not a TS constructor-parameter-property
  // shorthand: `node --experimental-strip-types` (this repo's own test
  // runner, package.json's `test` script) only strips types, it does not
  // transform TS-only syntax like `constructor(private readonly x: T)`
  // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — caught running this task's own
  // `pipeline/o11y-*.test.mjs` for real, not by reading docs).
  constructor(deps: SymbolicateDeps) {
    this.#deps = deps;
  }

  async get(key: string): Promise<SourceMapConsumer | null> {
    if (this.#parsed.has(key)) return this.#parsed.get(key) ?? null;
    if (this.#parsedBytes >= DrainMapCache.MAX_PARSED_BYTES) {
      this.#parsed.set(key, null);
      return null;
    }
    let text: string | null;
    try {
      text = await this.#deps.getMap(key);
    } catch {
      text = null;
    }
    if (text === null) {
      this.#parsed.set(key, null);
      return null;
    }
    this.#parsedBytes += text.length;
    let consumer: SourceMapConsumer | null;
    try {
      consumer = new SourceMapConsumer(JSON.parse(text) as RawSourceMap);
    } catch {
      consumer = null;
    }
    this.#parsed.set(key, consumer);
    return consumer;
  }
}

/** Resolves one exception's body text in place; returns the same string
 *  unchanged if there is nothing to resolve (no stack lines, or every frame
 *  is skipped/unresolvable). */
async function resolveBody(body: string, serviceVersion: string, cache: DrainMapCache): Promise<string> {
  const lines = body.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const frame = parseLine(raw);
    if (!frame || frame.line === undefined || frame.col === undefined) continue; // not a resolvable stack line
    if (isBabelChunk(frame.filename)) continue; // criterion 5: left unparsed, deliberately

    const mapKey = mapKeyFor(frame.filename, serviceVersion);
    if (!mapKey) continue;
    const consumer = await cache.get(mapKey);
    if (!consumer) continue; // no map, or it failed to parse — leave the frame exactly as it was

    // V8/ErrorEvent columns are 1-based; source-map-js's generated position
    // is 0-based column, 1-based line (the source-map spec's own convention).
    const original = consumer.originalPositionFor({ line: frame.line, column: Math.max(0, frame.col - 1) });
    if (original.line === null || original.line === undefined || !original.source) continue;

    lines[i] = renderLine({
      prefix: frame.prefix,
      fn: original.name ?? frame.fn,
      filename: original.source,
      line: original.line,
      col: (original.column ?? 0) + 1,
    });
    changed = true;
  }

  return changed ? lines.join("\n") : body;
}

function isExceptionRecord(record: OtlpResourceLogs): boolean {
  for (const scope of record.scopeLogs) {
    for (const log of scope.logRecords) {
      for (const attr of log.attributes ?? []) {
        if (attr.key === ATTR_HOT_KIND && attr.value.stringValue === "exception") return true;
      }
    }
  }
  return false;
}

function serviceVersionOf(record: OtlpResourceLogs): string | null {
  for (const attr of record.resource.attributes) {
    if (attr.key === "service.version") return attr.value.stringValue ?? null;
  }
  return null;
}

/**
 * Resolves every exception record's body in `records`, leaving every other
 * record untouched. One {@link DrainMapCache} per call — see its own doc
 * comment for why it must not persist across calls.
 */
export async function symbolicateResourceLogs(
  records: readonly OtlpResourceLogs[],
  deps: SymbolicateDeps,
): Promise<OtlpResourceLogs[]> {
  const cache = new DrainMapCache(deps);
  const out: OtlpResourceLogs[] = [];

  for (const record of records) {
    if (!isExceptionRecord(record)) {
      out.push(record);
      continue;
    }
    const serviceVersion = serviceVersionOf(record);
    if (!serviceVersion) {
      out.push(record);
      continue;
    }

    const resolvedScopeLogs = await Promise.all(
      record.scopeLogs.map(async (scope) => ({
        logRecords: await Promise.all(
          scope.logRecords.map(async (log) => {
            if (!log.body?.stringValue) return log;
            const resolvedBody = await resolveBody(log.body.stringValue, serviceVersion, cache);
            return resolvedBody === log.body.stringValue ? log : { ...log, body: { stringValue: resolvedBody } };
          }),
        ),
      })),
    );

    out.push({ ...record, scopeLogs: resolvedScopeLogs });
  }

  return out;
}
