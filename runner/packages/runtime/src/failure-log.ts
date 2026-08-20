// What a failed install/build log says went wrong (DEV-2533, DEV-2570).
//
// Two callers, one rule set: the Tier-2 container boot log (`container.ts`, one
// stream, pre-bounded by the status route's `tail -c 2500`) and the snapshot
// builder's `sbx.exec` results (`workers/api/src/share.ts`, two unbounded
// streams). Both used to turn a log into an `Error.message` and both produced the
// same defect — see `failureDetail` below for what that costs.
//
// Import-light on purpose: only `./monitor.js`, which is itself DOM-free, so the
// API Worker can import this subpath the way it already imports `./scheme`.

import { redactPreviewHosts, truncateMessage } from "./monitor.js";

/** Dev-server output worth relaying (DEV-2527). Broad on purpose — the point is to
 *  learn what running dev servers complain about — but narrow enough that ordinary
 *  request logging and HMR chatter do not qualify.
 *
 *  Lives here rather than in `container.ts` because it is also the second tier of
 *  the cause picker below; `container.ts` imports it back for `relayStderr`. */
export const STDERR_MARKERS =
  /\b(error|failed|failure|exception|unhandled|cannot find|not found|econnrefused|eaddrinuse)\b/i;

/** A line that ANNOUNCES a cause, as opposed to merely mentioning one. Anchored at the
 *  start of the line on purpose: pnpm prints its prose hints ("This error happened
 *  while installing the dependencies of …") AFTER the code line, so an unanchored scan
 *  from the end of the log picks the hint over ERR_PNPM_NO_MATCHING_VERSION.
 *
 *  Deliberately separate from STDERR_MARKERS rather than a widening of it: that set is
 *  load-bearing for `relayStderr`, where it controls how much dev-server noise is
 *  shipped as demo events. Two patterns, two jobs. */
const CAUSE_LINE = /^(?:err_[a-z0-9_]+|npm ERR!|ELIFECYCLE|::error::|[a-z]*error\b)/i;

/** The stable prefixes of a cause line — the part that is a machine code rather than
 *  prose, and therefore the only part safe to fingerprint a Sentry issue by. The
 *  `[a-z]*error\b` arm of `CAUSE_LINE` deliberately has no entry here: it matches
 *  sentences like "error during build: …", and keying a group by one of those shards
 *  the group per message, which is the very failure mode the fingerprint exists to
 *  prevent. */
const CAUSE_CODE = /^(?:(err_[a-z0-9_]+)|(elifecycle)|(npm ERR!)|(::error::))/i;

/** ANSI codes meaning "what follows replaces this line": erase-whole-line (`\x1b[2K`)
 *  and cursor-to-column (`\x1b[nG`). pnpm redraws its progress counter with these
 *  rather than with a bare `\r`, so stripping them as ordinary CSI would glue every
 *  redraw frame into one run-on line. Normalised to `\r` so one last-frame-wins rule
 *  covers both.
 *
 *  `2K` specifically, NOT `\d*K`: a bare `\x1b[K` is erase-to-end-of-line, the "wipe
 *  what the previous longer line left behind" idiom, and it usually trails the text it
 *  is protecting. Treating it as a reset would drop that text — deleting exactly the
 *  cause line this function exists to find. Those fall through to ANSI_CSI below and
 *  are stripped like any other code.
 *
 *  (`PreviewPane.tailLines` strips CSI first and therefore keeps redraw fragments.
 *  Deliberately stricter here: nothing there ends up as a Sentry issue title.) */
const LINE_RESET = /\x1b\[(?:2K|\d*G)/g;

/** Full CSI, not just colour (`m`): a boot log is mostly cursor movement. And pnpm
 *  colourises even when its output is a pipe, so the exec path needs this as much as
 *  the boot path does. */
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Readability bound on the kept window, and what `tail` promises callers. A boot log
 *  arrives already tailed to 2500 bytes; an exec result does not, which is why the
 *  builder raises it. */
const DEFAULT_KEEP_LINES = 40;

const DEFAULT_FALLBACK = "The process failed with no output.";

export interface FailureDetailOptions {
  /** How many trailing non-empty lines to keep. Default 40. */
  keepLines?: number;
  /** `cause` when the log yields nothing at all. */
  fallback?: string;
  /** Byte cap on `tail`, applied after redaction; a cut tail is marked with a leading
   *  `...`. Uncapped by default, which is what the boot path wants: its log arrives
   *  already tailed to 2500 bytes by the status route, and capping it again here would
   *  measure the CLEANED, redacted string — blank lines dropped, hosts replaced by
   *  `<preview>` — whose length is not the byte count that tail promised. The exec path
   *  has no such upstream bound and passes its own. */
  maxTailChars?: number;
}

export interface FailureDetail {
  /** One line: what to title an issue with, and what to show a user. Never multi-line. */
  cause: string;
  /** The recent output the cause was picked out of — context, never part of a message. */
  tail: string;
  /** The machine code the cause announced (`ERR_PNPM_NO_MATCHING_VERSION`, `ELIFECYCLE`,
   *  …), or `"other"`. A stable Sentry fingerprint key; the cause itself is not one. */
  code: string;
}

/** The last entry satisfying `pred` — the newest occurrence, since logs run forwards. */
function findLastLine(lines: readonly string[], pred: (line: string) => boolean): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (pred(lines[i]!)) return lines[i]!;
  }
  return null;
}

/** Strip the redraw frames and escape codes, drop blanks, keep the tail window. */
function cleanLines(log: string, keepLines: number): string[] {
  return log
    .replace(LINE_RESET, "\r")
    .replace(ANSI_CSI, "")
    .split("\n")
    .map((l) => l.slice(l.lastIndexOf("\r") + 1).trimEnd())
    .filter(Boolean)
    .slice(-keepLines);
}

const announcesCause = (line: string): boolean => CAUSE_LINE.test(line.trimStart());
const mentionsCause = (line: string): boolean => STDERR_MARKERS.test(line);

/** The machine code a cause line announces, or `"other"`. Normalised to an
 *  uppercase identifier — `npm ERR!` becomes `NPM_ERR`, `::error::` becomes `ERROR` —
 *  because this is a Sentry fingerprint key, and a key with spaces and punctuation in
 *  it reads as a stray message rather than a code. */
export function causeCode(cause: string): string {
  const m = CAUSE_CODE.exec(cause.trimStart());
  if (!m) return "other";
  return m[0].toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Redact, then truncate — the order is the security property (e0da4598): truncating
 *  first can cut a preview hostname in half and leave the session token behind in a
 *  form the redactor no longer recognises. Keeps the END of the log, since that is
 *  what a tail is for. */
function boundedTail(lines: readonly string[], maxTailChars: number | undefined): string {
  const redacted = redactPreviewHosts(lines.join("\n"));
  if (maxTailChars === undefined || redacted.length <= maxTailChars) return redacted;
  return `...${redacted.slice(-maxTailChars)}`;
}

function describe(
  candidate: string | null,
  lines: readonly string[],
  options: FailureDetailOptions,
): FailureDetail {
  const picked = (candidate ?? "").trim();
  const cause = truncateMessage(redactPreviewHosts(picked));
  return {
    cause: cause || (options.fallback ?? DEFAULT_FALLBACK),
    tail: boundedTail(lines, options.maxTailChars),
    code: picked ? causeCode(picked) : "other",
  };
}

/**
 * Split a failed log into the one line worth titling an issue with (`cause`) and the
 * recent context worth keeping beside it (`tail`).
 *
 * The whole log used to become the `Error.message` (DEV-2533, and again for the
 * snapshot builder in DEV-2570). A message that is a log takes the issue title from
 * whatever the tail happened to start with, and — because V8 puts the message inside
 * `error.stack` and stack parsers skip only the first line — feeds lines 2..n of it to
 * the frame regexes, inventing both a stack and a culprit. The actual cause, meanwhile,
 * sat unread further down.
 *
 * The cause is chosen in three tiers, each scanning backwards: a line that announces a
 * failure, else a line that mentions one, else the last line there is.
 */
export function failureDetail(log: string, options: FailureDetailOptions = {}): FailureDetail {
  const lines = cleanLines(log, options.keepLines ?? DEFAULT_KEEP_LINES);
  const candidate =
    findLastLine(lines, announcesCause) ??
    findLastLine(lines, mentionsCause) ??
    lines[lines.length - 1] ??
    null;
  return describe(candidate, lines, options);
}

/**
 * The same split for a failed `exec`, which has two streams rather than one log.
 *
 * The tiers run ACROSS the streams, not within a concatenation of them, and that is
 * the whole point of this entry point. Joining and scanning backwards makes the last
 * line of the last stream win, and neither ordering is right on its own: pnpm keeps
 * counting progress on stdout long after it has written its diagnosis to stderr, while
 * vite/ng/next report genuine build errors on stdout and leave stderr carrying trailing
 * deprecation and browserslist noise. Preferring an ANNOUNCED cause on either stream
 * over a merely MENTIONED one on either stream settles both cases; stderr breaks the
 * tie within a tier.
 *
 * `tail` keeps stdout first and stderr last, so when the byte cap bites it is the
 * diagnosis that survives.
 */
export function execFailureDetail(
  result: { stdout?: string; stderr?: string },
  options: FailureDetailOptions = {},
): FailureDetail {
  const keepLines = options.keepLines ?? DEFAULT_KEEP_LINES;
  const err = cleanLines(result.stderr ?? "", keepLines);
  const out = cleanLines(result.stdout ?? "", keepLines);
  const candidate =
    findLastLine(err, announcesCause) ??
    findLastLine(out, announcesCause) ??
    findLastLine(err, mentionsCause) ??
    findLastLine(out, mentionsCause) ??
    err[err.length - 1] ??
    out[out.length - 1] ??
    null;
  return describe(candidate, [...out, ...err], options);
}
