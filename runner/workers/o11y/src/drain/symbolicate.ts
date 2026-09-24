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

/**
 * Advisor sweep finding (post-report, same Z-B-C1 file): `STACK_LINE_RE`'s
 * two lazy groups (`(.+?)`, `(.+?)`) separated by a required ` (` literal
 * are quadratic on a line shaped like `"    at a (a (a (…"` — no `/g`, so
 * it is only tried once per line (anchored `^…$`), but that ONE attempt
 * still backtracks catastrophically across every ambiguous split point.
 * Measured directly (`node -e`, the two-group regex alone): 5k chars 5ms,
 * 10k 20ms, 20k 74ms, 40k 305ms — roughly ×4 per ×2, i.e. quadratic.
 * Projected to `SCRUB_TEXT_MAX_CHARS` (256 KB, the cap Z-A-C1 truncates
 * every free-text string to, including an exception `value` that becomes
 * this body's first line): tens of seconds. A CPU-limit kill from this is
 * not a JS throw, so none of this module's three throw-shaped guards
 * (the `line < 1` check, the `originalPositionFor` try/catch,
 * `symbolicateResourceLogs`'s per-record try/catch) would catch it — the
 * regex call itself never returns. A real frame line
 * (`convert.ts#formatStackFrame`'s own output: a `"    at "` prefix, a
 * function name, and a scrubbed URL with its query already stripped) is
 * nowhere near this length; skipping anything longer costs no real frame
 * resolution and removes the attack surface at its cheapest point — before
 * the regex ever runs, matching this whole fix round's "truncate first"
 * approach (Z-A-C1).
 */
const MAX_STACK_LINE_LENGTH = 4096;

interface ParsedFrame {
  prefix: string;
  fn: string;
  filename: string;
  line?: number;
  col?: number;
}

function parseLine(line: string): ParsedFrame | null {
  if (line.length > MAX_STACK_LINE_LENGTH) return null; // guard STACK_LINE_RE against catastrophic backtracking before it ever runs
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
 *  is skipped/unresolvable).
 *
 *  Fix round (finding Z-B-C1): never throws. Two independent guards, both
 *  load-bearing on their own:
 *
 *  1. A frame with `line < 1` (or a non-finite line/col — defensive; the
 *     regex above only ever captures digits, so this should be unreachable,
 *     but a *guaranteed* skip is cheap and this function's whole job is to
 *     never trust the input) is skipped before ever reaching
 *     `source-map-js`. `originalPositionFor({ line: 0, ... })` throws
 *     `TypeError: Line must be greater than or equal to 1, got 0` — a
 *     `lineno: 0` stack frame is valid, storable Faro input (ingest does
 *     not reject it), so this is reachable from one anonymous
 *     `POST /telemetry/collect` request, not a contrived shape.
 *  2. Even so, `originalPositionFor` is wrapped in its own try/catch,
 *     leaving the frame byte-for-byte unresolved on any other throw the
 *     library might raise — the same "resolve or leave exactly as
 *     rendered, never guess, never throw" contract every other skip
 *     condition in this loop already follows (see the file header). */
async function resolveBody(body: string, serviceVersion: string, cache: DrainMapCache): Promise<string> {
  const lines = body.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const frame = parseLine(raw);
    if (!frame || frame.line === undefined || frame.col === undefined) continue; // not a resolvable stack line
    if (!Number.isFinite(frame.line) || !Number.isFinite(frame.col) || frame.line < 1) continue; // Z-B-C1: a line-0 (or otherwise invalid) frame is left unresolved, never passed to the map consumer
    if (isBabelChunk(frame.filename)) continue; // criterion 5: left unparsed, deliberately

    const mapKey = mapKeyFor(frame.filename, serviceVersion);
    if (!mapKey) continue;
    const consumer = await cache.get(mapKey);
    if (!consumer) continue; // no map, or it failed to parse — leave the frame exactly as it was

    // V8/ErrorEvent columns are 1-based; source-map-js's generated position
    // is 0-based column, 1-based line (the source-map spec's own convention).
    let original: ReturnType<SourceMapConsumer["originalPositionFor"]>;
    try {
      original = consumer.originalPositionFor({ line: frame.line, column: Math.max(0, frame.col - 1) });
    } catch {
      continue; // Z-B-C1: a library throw on this one frame must not cost the rest of the body
    }
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
            // Z-B-C1 "guard the record": `resolveBody` above is already
            // written to never throw, but this is the second, independent
            // layer the finding asks for — a throw here (from `resolveBody`
            // itself, or from anything `source-map-js` does that this
            // module did not anticipate) must leave THIS record's body
            // exactly as it arrived, never escape and cost every record
            // after it in the batch (`drain.ts#drainKey` is the third
            // layer, isolating a whole KEY the same way).
            let resolvedBody: string;
            try {
              resolvedBody = await resolveBody(log.body.stringValue, serviceVersion, cache);
            } catch {
              resolvedBody = log.body.stringValue;
            }
            return resolvedBody === log.body.stringValue ? log : { ...log, body: { stringValue: resolvedBody } };
          }),
        ),
      })),
    );

    out.push({ ...record, scopeLogs: resolvedScopeLogs });
  }

  return out;
}
