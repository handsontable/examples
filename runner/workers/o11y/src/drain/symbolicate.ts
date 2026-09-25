// ADR §C.3 — symbolication in the Worker, at drain, for exception records
// only. `convert.ts#faroBody` (T03 addition) renders a Faro exception's
// stack as plain text in the record body, standard V8 shape:
//
//   TypeError: x is not a function
//       at fn (https://demos.handsontable.com/assets/index-abc123.js:12:34)
//
// This module parses that text back into frames, resolves app-chunk frames
// with `@jridgewell/trace-mapping` against `sourcemaps/<service.version>/
// <original asset path>.map` (the maps bucket), and rewrites resolved lines
// in place.
//
// F30 (why not `source-map-js`, which this module used until then): its
// `lib/quick-sort.js` builds the comparator-specialised sort it runs on the
// first `originalPositionFor` with `new Function(...)`. workerd forbids
// code generation from strings, so inside the real Worker EVERY lookup
// threw `EvalError: Code generation from strings disallowed for this
// context`, the per-frame catch below swallowed it, and no frame was ever
// resolved in production or under `wrangler dev`, while every Node unit
// test (Node allows `new Function`) stayed green.
// `pipeline/o11y-symbolicate-drain.test.mjs` runs the drain under
// `node --disallow-code-generation-from-strings` so that class of
// dependency cannot come back unnoticed. `trace-mapping` does no code
// generation.
// Frames it cannot or must not resolve (Babel-chunk, third-party, a missing
// or unparseable map) are left byte-for-byte as rendered — never a
// placeholder, never a partial guess — so drain-time symbolication produces
// the exact same body text on every replay of the same source record
// (exit criterion 2's "a log query equals a single clean replay" needs
// this: a body that could come out differently on a re-drain after an
// unclean stop would make the replay's line diverge from a clean run's).

import { ATTR_HOT_KIND, type OtlpResourceLogs } from "@handsontable/demo-runtime/telemetry";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

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
    // F30: a frame in the page itself (an inline `<script>`, e.g.
    // `at eval (http://host/:303:30)`) has no file to map. Without this the
    // symbolicator fetched `sourcemaps/<sha>/.map` for every such frame and
    // reported it as a missing map.
    if (url.pathname.endsWith("/")) return null;
    return `sourcemaps/${serviceVersion}${url.pathname}.map`;
  } catch {
    return null;
  }
}

/** Workspace directories directly under the `runner/` checkout root. */
const WORKSPACE_ROOTS: ReadonlySet<string> = new Set(["apps", "packages", "workers", "node_modules"]);

/**
 * F30 (render-time source-path normalisation): turns a map `sources` entry
 * into a repo-relative path for the rendered frame. Rollup writes each
 * source relative to the map file, so a CI build (`apps/authoring/dist`)
 * emits `../../src/sentry.ts` or `../../../../packages/runtime/dist/monitor.js`,
 * and a build into any other outDir climbs out of the checkout entirely
 * (`../../../../../../../../Users/<user>/Code/examples/runner/...`), which
 * leaks a home directory into Loki.
 *
 * Rule: drop leading `./`, `../` and `/`; then, if a `runner/<workspace
 * root>` pair remains, cut everything before the workspace root. The LAST
 * such pair wins, so a GitHub Actions checkout
 * (`/home/runner/work/examples/examples/runner/apps/...`) is cut at the
 * repo's own `runner/`, not the CI user's home. The CI build therefore
 * renders `src/sentry.ts` / `packages/runtime/dist/monitor.js`, which is
 * what ADR-0041 exit criterion 5 names. A URL source (`https://...`) is left
 * as it is.
 *
 * Done at render time, not with Vite's `sourcemapPathTransform` at build
 * time, because the same maps are uploaded to Sentry: changing `sources`
 * there changes Sentry's frame filenames and so its issue grouping and any
 * code mappings. Render time also fixes maps already in the bucket.
 */
export function normaliseSourcePath(source: string): string {
  if (/^[a-z][\w+.-]*:\/\//i.test(source) && !source.startsWith("file://")) return source;
  const segments = source.replace(/^file:\/\//, "").replace(/\\/g, "/").split("/");
  let start = 0;
  while (start < segments.length - 1 && (segments[start] === "" || segments[start] === "." || segments[start] === "..")) start++;
  const rest = segments.slice(start);
  for (let i = rest.length - 2; i >= 0; i--) {
    if (rest[i] === "runner" && WORKSPACE_ROOTS.has(rest[i + 1] ?? "")) return rest.slice(i + 1).join("/");
  }
  return rest.join("/");
}

/** F30: why a map key's frames were left unresolved. `fetch_error` (the
 *  read threw) is kept apart from `no_map` (the object is absent) so a
 *  transient R2 failure is not read as a missing upload (B-M6). */
export type SymbolicateSkipReason =
  | "no_map"
  | "fetch_error"
  | "parse_error"
  | "over_budget"
  | "lookup_error"
  | "no_frames_matched";

export interface SymbolicateSkip {
  /** The maps-bucket key, e.g. `sourcemaps/<sha>/assets/index-abc.js.map`. */
  key: string;
  reason: SymbolicateSkipReason;
  /** Frames that pointed at this key and stayed unresolved. */
  frames: number;
  /** The first underlying error message, truncated; absent for `no_map`,
   *  `over_budget` and `no_frames_matched`. */
  detail?: string;
}

export interface SymbolicateDeps {
  /** Reads one map object; `null` when absent (never fetches from the app
   *  origin — the task's own Trap: "a rotated hash answers `200 text/html`"
   *  is exactly why this must be the maps bucket, never a `fetch()` to
   *  `demos.handsontable.com`). */
  getMap(key: string): Promise<string | null>;
  /** F30: called at most once per {@link symbolicateResourceLogs} call when
   *  any key had frames that were attempted and left unresolved, with at
   *  most {@link MAX_SKIP_REPORTS} entries (one per key) and the number of
   *  further keys left out. Defaults to {@link logSymbolicateSkips}. Never
   *  affects the rendered output. */
  onSkip?(skips: SymbolicateSkip[], suppressed: number): void;
}

/** Bounds the skip signal: a batch carrying many distinct, map-less chunk
 *  URLs (third-party scripts, a forged payload) costs one line per key up
 *  to this many, then one count. */
export const MAX_SKIP_REPORTS = 20;
const MAX_SKIP_DETAIL_CHARS = 200;

/** The default {@link SymbolicateDeps.onSkip}: one structured
 *  `o11y.symbolicate.skip` line per key, the same JSON-line shape as the
 *  worker's other `o11y.*` events, plus one line for the suppressed count. */
export function logSymbolicateSkips(skips: SymbolicateSkip[], suppressed: number): void {
  for (const skip of skips) console.warn(JSON.stringify({ event: "o11y.symbolicate.skip", ...skip }));
  if (suppressed > 0) console.warn(JSON.stringify({ event: "o11y.symbolicate.skip", reason: "suppressed", keys: suppressed }));
}

function errorDetail(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_SKIP_DETAIL_CHARS);
}

interface KeyStats {
  attempted: number;
  resolved: number;
  lookupErrors: number;
  lookupDetail?: string;
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
  #parsed = new Map<string, TraceMap | null>();
  /** F30: why a key resolved to `null`, for the skip signal. */
  #failures = new Map<string, { reason: SymbolicateSkipReason; detail?: string }>();
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

  failureOf(key: string): { reason: SymbolicateSkipReason; detail?: string } | undefined {
    return this.#failures.get(key);
  }

  #fail(key: string, reason: SymbolicateSkipReason, detail?: string): null {
    this.#parsed.set(key, null);
    this.#failures.set(key, detail === undefined ? { reason } : { reason, detail });
    return null;
  }

  async get(key: string): Promise<TraceMap | null> {
    if (this.#parsed.has(key)) return this.#parsed.get(key) ?? null;
    if (this.#parsedBytes >= DrainMapCache.MAX_PARSED_BYTES) return this.#fail(key, "over_budget");
    let text: string | null;
    try {
      text = await this.#deps.getMap(key);
    } catch (err) {
      return this.#fail(key, "fetch_error", errorDetail(err));
    }
    if (text === null) return this.#fail(key, "no_map");
    this.#parsedBytes += text.length;
    let map: TraceMap;
    try {
      map = new TraceMap(text);
    } catch (err) {
      return this.#fail(key, "parse_error", errorDetail(err));
    }
    this.#parsed.set(key, map);
    return map;
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
 *     the map library. `originalPositionFor({ line: 0, ... })` throws (in
 *     `source-map-js`, used until F30: `TypeError: Line must be greater
 *     than or equal to 1, got 0`; in `trace-mapping`: "`line` must be
 *     greater than 0") — a
 *     `lineno: 0` stack frame is valid, storable Faro input (ingest does
 *     not reject it), so this is reachable from one anonymous
 *     `POST /telemetry/collect` request, not a contrived shape.
 *  2. Even so, `originalPositionFor` is wrapped in its own try/catch,
 *     leaving the frame byte-for-byte unresolved on any other throw the
 *     library might raise — the same "resolve or leave exactly as
 *     rendered, never guess, never throw" contract every other skip
 *     condition in this loop already follows (see the file header). */
async function resolveBody(
  body: string,
  serviceVersion: string,
  cache: DrainMapCache,
  stats: Map<string, KeyStats>,
): Promise<string> {
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
    let keyStats = stats.get(mapKey);
    if (!keyStats) {
      keyStats = { attempted: 0, resolved: 0, lookupErrors: 0 };
      stats.set(mapKey, keyStats);
    }
    keyStats.attempted++;
    const map = await cache.get(mapKey);
    if (!map) continue; // no map, or it failed to parse — leave the frame exactly as it was (reported via the skip signal)

    // V8/ErrorEvent columns are 1-based; trace-mapping's generated position
    // is 0-based column, 1-based line (the source-map spec's own convention).
    let original: ReturnType<typeof originalPositionFor>;
    try {
      original = originalPositionFor(map, { line: frame.line, column: Math.max(0, frame.col - 1) });
    } catch (err) {
      // Z-B-C1: a library throw on this one frame must not cost the rest of the body.
      keyStats.lookupErrors++;
      keyStats.lookupDetail ??= errorDetail(err);
      continue;
    }
    if (original.line === null || original.line === undefined || !original.source) continue;

    lines[i] = renderLine({
      prefix: frame.prefix,
      fn: original.name ?? frame.fn,
      filename: normaliseSourcePath(original.source),
      line: original.line,
      col: (original.column ?? 0) + 1,
    });
    keyStats.resolved++;
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
  const stats = new Map<string, KeyStats>();
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
            // itself, or from anything the map library does that this
            // module did not anticipate) must leave THIS record's body
            // exactly as it arrived, never escape and cost every record
            // after it in the batch (`drain.ts#drainKey` is the third
            // layer, isolating a whole KEY the same way).
            let resolvedBody: string;
            try {
              resolvedBody = await resolveBody(log.body.stringValue, serviceVersion, cache, stats);
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

  reportSkips(stats, cache, deps.onSkip ?? logSymbolicateSkips);
  return out;
}

/** F30: one entry per map key whose frames were attempted and not all
 *  resolved for a reason worth an operator's attention, in first-seen key
 *  order. A key with at least one resolved frame is only reported for a
 *  `lookup_error`: a frame the map has no mapping for is normal, a library
 *  throw is not. A reporter that throws is ignored, so the signal can never
 *  cost the drain. */
function reportSkips(
  stats: Map<string, KeyStats>,
  cache: DrainMapCache,
  onSkip: NonNullable<SymbolicateDeps["onSkip"]>,
): void {
  const skips: SymbolicateSkip[] = [];
  let suppressed = 0;
  for (const [key, s] of stats) {
    const unresolved = s.attempted - s.resolved;
    if (unresolved === 0) continue;
    const failure = cache.failureOf(key);
    let skip: SymbolicateSkip | null = null;
    if (failure) skip = { key, reason: failure.reason, frames: unresolved, ...(failure.detail !== undefined ? { detail: failure.detail } : {}) };
    else if (s.lookupErrors > 0) skip = { key, reason: "lookup_error", frames: unresolved, ...(s.lookupDetail !== undefined ? { detail: s.lookupDetail } : {}) };
    else if (s.resolved === 0) skip = { key, reason: "no_frames_matched", frames: unresolved };
    if (!skip) continue;
    if (skips.length < MAX_SKIP_REPORTS) skips.push(skip);
    else suppressed++;
  }
  if (skips.length === 0) return;
  try {
    onSkip(skips, suppressed);
  } catch {
    // the signal is best-effort; the resolved records are already built
  }
}
