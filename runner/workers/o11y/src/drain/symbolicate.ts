// ADR §C.3 — symbolication in the Worker, at drain, for exception records
// only: parses a Faro exception's rendered V8 stack text back into frames,
// resolves app-chunk frames with `@jridgewell/trace-mapping` (not
// `source-map-js`: workerd forbids code generation from strings) against
// `sourcemaps/<service.version>/<path>.map`. Unresolvable frames are left
// byte-for-byte, so a replay always produces the same body text.

import { ATTR_HOT_KIND, type OtlpResourceLogs } from "@handsontable/demo-runtime/telemetry";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

/** Exactly `convert.ts#formatStackFrame`'s output shape, parsed back out.
 *  Filename is greedy-but-bounded to the LAST `:<digits>:<digits>` before
 *  the closing paren, so a URL's own `https:` colon isn't mis-split. */
const STACK_LINE_RE = /^( {4}at )(.+?) \((.+?)(?::(\d+):(\d+))?\)$/;

/**
 * `STACK_LINE_RE`'s two lazy groups are quadratic on a line shaped like
 * `"    at a (a (a (…"`. Measured: 5k chars 5ms, 10k 20ms, 20k 74ms, 40k
 * 305ms — roughly quadratic. Projected to `SCRUB_TEXT_MAX_CHARS` (256 KB):
 * tens of seconds, and a CPU-limit kill from this is not a JS throw, so no
 * try/catch would catch it. A real frame line is nowhere near this length.
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

/** CI names its Babel compiler bundle with a `babel-` filename prefix
 *  (a deploy-rotated chunk like `babel-<hash>.js`). Criterion 5 requires
 *  these frames left unparsed, not merely unresolved for lack of a map. */
function isBabelChunk(filename: string): boolean {
  try {
    const path = new URL(filename).pathname;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return /^babel-[\w.-]+\.js$/i.test(base);
  } catch {
    return /(?:^|\/)babel-[\w.-]+\.js$/i.test(filename);
  }
}

/** `sourcemaps/<service.version>/<original asset path>.map` (ADR §C.3).
 *  `null` when `filename` is not a parseable URL — a preview-host frame
 *  correctly never resolves to a real map. */
function mapKeyFor(filename: string, serviceVersion: string): string | null {
  try {
    const url = new URL(filename);
    // A frame in the page itself (inline `<script>`) has no file to map —
    // without this the symbolicator would fetch a nonexistent map and
    // report it as missing.
    if (url.pathname.endsWith("/")) return null;
    return `sourcemaps/${serviceVersion}${url.pathname}.map`;
  } catch {
    return null;
  }
}

/** Workspace directories directly under the `runner/` checkout root. */
const WORKSPACE_ROOTS: ReadonlySet<string> = new Set(["apps", "packages", "workers", "node_modules"]);

/**
 * Render-time source-path normalisation: turns a map `sources` entry into
 * a repo-relative path. Rollup writes sources relative to the map file, so
 * a build into any outDir can climb out of the checkout, leaking a home
 * directory into Loki. Cuts everything before the last `runner/<workspace
 * root>` pair; done at render time since the same maps go to Sentry too.
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

/** Why a map key's frames were left unresolved. `fetch_error` (the read
 *  threw) is kept apart from `no_map` (the object is absent) so a
 *  transient R2 failure is not read as a missing upload. */
export type SymbolicateSkipReason =
  | "no_map"
  | "fetch_error"
  | "parse_error"
  | "over_budget"
  | "over_cap"
  | "lookup_error"
  | "no_frames_matched";

/** Distinct map keys one call (one inbox object) may read from R2: an
 *  authoring build ships 7 JS chunks (`vite build`), so 32 covers four builds'
 *  chunks in one object, while a body of forged frame URLs costs 32 GETs. */
export const MAX_MAP_KEYS_PER_CALL = 32;
/** Frames looked up per body: the deepest browser stack is SpiderMonkey's
 *  128 frames (V8 reports 10, JavaScriptCore 100). */
export const MAX_FRAMES_PER_BODY = 128;

export interface SymbolicateSkip {
  /** The maps-bucket key, e.g. `sourcemaps/<sha>/assets/index-abc.js.map`. */
  key: string;
  reason: SymbolicateSkipReason;
  /** Frames that pointed at this key and stayed unresolved. */
  frames: number;
  /** The first underlying error message, truncated; absent for `no_map`,
   *  `over_budget`, `over_cap` and `no_frames_matched`. */
  detail?: string;
}

export interface SymbolicateDeps {
  /** Reads one map object; `null` when absent — never fetches from the
   *  app origin (a rotated deploy hash can answer `200 text/html`). */
  getMap(key: string): Promise<string | null>;
  /** Called at most once per call when any key had unresolved frames, up
   *  to {@link MAX_SKIP_REPORTS} entries. Defaults to
   *  {@link logSymbolicateSkips}. Never affects the rendered output. */
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
function logSymbolicateSkips(skips: SymbolicateSkip[], suppressed: number): void {
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
  /** Frames past {@link MAX_FRAMES_PER_BODY} or {@link MAX_MAP_KEYS_PER_CALL}, never looked up. */
  capped: number;
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
  /** Why a key resolved to `null`, for the skip signal. */
  #failures = new Map<string, { reason: SymbolicateSkipReason; detail?: string }>();
  #parsedBytes = 0;
  /** A generous per-invocation ceiling on total parsed map JSON, well
   *  under the 64 MB isolate-memory budget criterion 5 sets — a
   *  batch-wide cap against a pathological object with many chunk files. */
  static readonly MAX_PARSED_BYTES = 48 * 1024 * 1024;

  readonly #deps: SymbolicateDeps;

  // A plain field assignment, not a constructor-parameter-property: this
  // repo's `node --experimental-strip-types` test runner only strips
  // types, not TS-only constructor-param syntax.
  constructor(deps: SymbolicateDeps) {
    this.#deps = deps;
  }

  failureOf(key: string): { reason: SymbolicateSkipReason; detail?: string } | undefined {
    return this.#failures.get(key);
  }

  /** The map {@link get} already loaded for `key`, or `null`. */
  loaded(key: string): TraceMap | null {
    return this.#parsed.get(key) ?? null;
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

interface PlannedFrame {
  index: number;
  frame: ParsedFrame & { line: number; col: number };
  mapKey: string;
}

interface PlannedBody {
  lines: string[];
  frames: PlannedFrame[];
}

function statsFor(stats: Map<string, KeyStats>, mapKey: string): KeyStats {
  let keyStats = stats.get(mapKey);
  if (!keyStats) {
    keyStats = { attempted: 0, resolved: 0, capped: 0, lookupErrors: 0 };
    stats.set(mapKey, keyStats);
  }
  return keyStats;
}

/** Picks the frames of one body to look up, in line order, admitting map keys
 *  into `admitted` up to {@link MAX_MAP_KEYS_PER_CALL}. Synchronous and
 *  order-only, so which frames are capped never depends on R2 timing. A
 *  `line < 1` frame is skipped (`originalPositionFor({line:0})` throws, and a
 *  `lineno: 0` frame is valid Faro input). */
function planBody(body: string, serviceVersion: string, admitted: Set<string>, stats: Map<string, KeyStats>): PlannedBody {
  const lines = body.split("\n");
  const frames: PlannedFrame[] = [];
  let candidates = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const frame = parseLine(raw);
    if (!frame || frame.line === undefined || frame.col === undefined) continue; // not a resolvable stack line
    if (!Number.isFinite(frame.line) || !Number.isFinite(frame.col) || frame.line < 1) continue;
    if (isBabelChunk(frame.filename)) continue; // criterion 5: left unparsed, deliberately
    const mapKey = mapKeyFor(frame.filename, serviceVersion);
    if (!mapKey) continue;
    const keyStats = statsFor(stats, mapKey);
    candidates++;
    if (candidates > MAX_FRAMES_PER_BODY || (!admitted.has(mapKey) && admitted.size >= MAX_MAP_KEYS_PER_CALL)) {
      keyStats.capped++;
      continue;
    }
    admitted.add(mapKey);
    frames.push({ index: i, frame: { ...frame, line: frame.line, col: frame.col }, mapKey });
  }
  return { lines, frames };
}

/** Resolves a planned body against the maps already loaded into `cache`;
 *  the original text if nothing resolves. `originalPositionFor` is wrapped
 *  so a library throw leaves that one frame byte-for-byte unresolved. */
function renderBody(body: string, plan: PlannedBody, cache: DrainMapCache, stats: Map<string, KeyStats>): string {
  const { lines } = plan;
  let changed = false;
  for (const { index, frame, mapKey } of plan.frames) {
    const keyStats = statsFor(stats, mapKey);
    keyStats.attempted++;
    const map = cache.loaded(mapKey);
    if (!map) continue; // no map, or it failed to parse — leave the frame exactly as it was (reported via the skip signal)

    // V8/ErrorEvent columns are 1-based; trace-mapping's generated position
    // is 0-based column, 1-based line (the source-map spec's own convention).
    let original: ReturnType<typeof originalPositionFor>;
    try {
      original = originalPositionFor(map, { line: frame.line, column: Math.max(0, frame.col - 1) });
    } catch (err) {
      keyStats.lookupErrors++;
      keyStats.lookupDetail ??= errorDetail(err);
      continue;
    }
    if (original.line === null || original.line === undefined || !original.source) continue;

    lines[index] = renderLine({
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
 * comment for why it must not persist across calls. Plans every body first,
 * then reads the admitted maps one at a time in first-seen order, so the
 * R2 reads are capped at {@link MAX_MAP_KEYS_PER_CALL} and the output is
 * the same on every replay.
 */
export async function symbolicateResourceLogs(
  records: readonly OtlpResourceLogs[],
  deps: SymbolicateDeps,
): Promise<OtlpResourceLogs[]> {
  const cache = new DrainMapCache(deps);
  const stats = new Map<string, KeyStats>();
  const admitted = new Set<string>();
  const plans = new Map<object, PlannedBody>();

  for (const record of records) {
    if (!isExceptionRecord(record)) continue;
    const serviceVersion = serviceVersionOf(record);
    if (!serviceVersion) continue;
    for (const scope of record.scopeLogs) {
      for (const log of scope.logRecords) {
        if (!log.body?.stringValue) continue;
        try {
          plans.set(log, planBody(log.body.stringValue, serviceVersion, admitted, stats));
        } catch {
          // a body that cannot be planned is left as it is
        }
      }
    }
  }

  for (const mapKey of admitted) await cache.get(mapKey);

  const out: OtlpResourceLogs[] = [];
  for (const record of records) {
    if (!isExceptionRecord(record) || !serviceVersionOf(record)) {
      out.push(record);
      continue;
    }
    const resolvedScopeLogs = record.scopeLogs.map((scope) => ({
      logRecords: scope.logRecords.map((log) => {
        const plan = plans.get(log);
        if (!plan || !log.body?.stringValue) return log;
        let resolvedBody: string;
        try {
          resolvedBody = renderBody(log.body.stringValue, plan, cache, stats);
        } catch {
          resolvedBody = log.body.stringValue;
        }
        return resolvedBody === log.body.stringValue ? log : { ...log, body: { stringValue: resolvedBody } };
      }),
    }));
    out.push({ ...record, scopeLogs: resolvedScopeLogs });
  }

  reportSkips(stats, cache, deps.onSkip ?? logSymbolicateSkips);
  return out;
}

/** One entry per map key whose frames were attempted and not all
 *  resolved, in first-seen order. A key with at least one resolved frame
 *  is only reported for a `lookup_error` or `over_cap`, not a normal
 *  unmatched frame. */
function reportSkips(
  stats: Map<string, KeyStats>,
  cache: DrainMapCache,
  onSkip: NonNullable<SymbolicateDeps["onSkip"]>,
): void {
  const skips: SymbolicateSkip[] = [];
  let suppressed = 0;
  for (const [key, s] of stats) {
    const unresolved = s.attempted - s.resolved + s.capped;
    if (unresolved === 0) continue;
    const failure = cache.failureOf(key);
    let skip: SymbolicateSkip | null = null;
    if (failure) skip = { key, reason: failure.reason, frames: unresolved, ...(failure.detail !== undefined ? { detail: failure.detail } : {}) };
    else if (s.lookupErrors > 0) skip = { key, reason: "lookup_error", frames: unresolved, ...(s.lookupDetail !== undefined ? { detail: s.lookupDetail } : {}) };
    else if (s.capped > 0) skip = { key, reason: "over_cap", frames: unresolved };
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
