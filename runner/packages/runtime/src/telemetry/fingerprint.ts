// Observability contract §7 — fingerprint.
//
// Synchronous and identical in browser and Worker (both run this same module),
// so a browser-computed and a Worker-computed fingerprint for the same message
// always agree — `pipeline/telemetry-fingerprint.test.mjs` checks that against a
// build of this module run through Node directly, not just self-consistency.

import { normalizeMonitorMessage } from "../monitor.js";
import type { Surface } from "./attrs.js";

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a, 64-bit, over the UTF-8 bytes of `value`. Pinned to the published test
 *  vectors (T00-D3: byte encoding is UTF-8, the natural choice for a JS string):
 *  `""` → `cbf29ce484222325` (the bare offset basis), `"a"` → `af63dc4c8601ec8c`,
 *  `"foobar"` → `85944171f73967e8`. */
function fnv1a64Hex(value: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Explicitly strip a Babel code-frame (as `@babel/standalone`'s
 * `codeFrameColumns` renders it — see `transpile.ts`) out of a message:
 *
 * ```text
 *   1 | function f() {
 * > 2 |   return x +;
 *     |             ^
 *   3 | }
 * ```
 *
 * `normalizeMonitorMessage` does not do this — it collapses whitespace
 * line-by-line-insensitively but has no notion of a gutter — so authored source
 * text would otherwise survive into both the fingerprint and (via `scrub.ts`) the
 * inbox. Two line shapes are removed: a numbered gutter line (`> N | …` or
 * `  N | …`, the source line, possibly empty after the bar) and a caret line
 * (bar, then spaces, then one or more `^`). Must run **before**
 * `normalizeMonitorMessage`, which collapses newlines and would destroy the
 * line-anchored shape these two patterns match (T00-D3).
 */
export function stripCodeFrame(message: string): string {
  const GUTTER_LINE = /^[ \t]*>?[ \t]*\d+[ \t]*\|.*$/;
  const CARET_LINE = /^[ \t]*\|[ \t]*\^+[ \t]*$/;
  return message
    .split("\n")
    .filter((line) => !GUTTER_LINE.test(line) && !CARET_LINE.test(line))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * `<context>:<16 hex chars of FNV-1a 64 over the normalised message>` (§7).
 *
 * `context` is caller-chosen and not normalised — it is typically `hot.surface`
 * or a metric name, kept short and already a controlled value, unlike `message`.
 */
export function fingerprint(context: string, message: string): string {
  const normalised = normalizeMonitorMessage(stripCodeFrame(message));
  return `${context}:${fnv1a64Hex(normalised)}`;
}

/**
 * §7: "Demo-runtime fingerprints never feed the new-fingerprint alert" — the
 * exact first-seen registry (`fp:<fingerprint>` in `InboxWriter`, contract §8,
 * ADR §F.3) is keyed by fingerprint, but skips writing/checking the key when
 * this returns `false`. Authored-code keystroke ladders are expected, not a
 * signal of a new defect.
 */
export function feedsNewFingerprintAlert(surface: Surface): boolean {
  return surface !== "demo-runtime";
}

/**
 * §7's exact wire shape (`<context>:<16 hex chars>`) — used to validate a
 * client-supplied fingerprint (a Faro item's own `payload.fingerprint`, or
 * `context["hot.fingerprint"]`) before it is trusted verbatim (fix round,
 * finding A-C2/D-I3). Without this, an attacker's arbitrary string reaches
 * the exact first-seen `fp:` registry (`InboxWriter`) and, from there, an
 * unescaped Slack alert line — this shape check is the first of two layers,
 * `notify.ts`'s own mrkdwn escaping is the second (defence in depth, since
 * other rules interpolate data into Slack text too).
 */
const FINGERPRINT_PATTERN = /^[a-z][a-z0-9_-]{0,63}:[0-9a-f]{16}$/;

export function isValidFingerprint(value: string): boolean {
  return FINGERPRINT_PATTERN.test(value);
}
