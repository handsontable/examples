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
 *  vectors (byte encoding is UTF-8, the natural choice for a JS string):
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
 * Strips a Babel code-frame (`@babel/standalone`'s `codeFrameColumns`, see
 * `transpile.ts`) out of a message, so authored source text does not survive
 * into the fingerprint or (via `scrub.ts`) the inbox. Must run BEFORE
 * `normalizeMonitorMessage`, which collapses newlines this shape depends on.
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
  return `${context}:${fnv1a64Hex(fingerprintShape(message))}`;
}

/**
 * The normalised text `fingerprint()` hashes: code frame stripped, then
 * `normalizeMonitorMessage`. Also the only message text a demo-runtime Faro
 * record carries (contract §3, §6). Idempotent
 * (`pipeline/demo-event-collapse.test.mjs`), so the record's own fingerprint
 * agrees with the metric point's.
 */
export function fingerprintShape(message: string): string {
  return normalizeMonitorMessage(stripCodeFrame(message));
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
 * §7's exact wire shape (`<context>:<16 hex chars>`) — validates a
 * client-supplied fingerprint before it is trusted verbatim, so an
 * attacker's string cannot reach the `fp:` first-seen registry
 * (`InboxWriter`) or an unescaped Slack alert line. Anchors on the LAST `:`
 * to allow `context`'s own `:`-joined segments (e.g.
 * `"docs-example-load:fetch"`). One shared pattern with
 * `normalise/otlp.ts#apiFingerprintFeed` and `normalise/faro.ts#resolveFingerprint`.
 * `context` is capped at {@link MAX_FINGERPRINT_CONTEXT_LENGTH}.
 */
const MAX_FINGERPRINT_CONTEXT_LENGTH = 128;
const FINGERPRINT_PATTERN =
  /^[a-z][a-z0-9._-]*(?::[a-z0-9._-]+)*:[0-9a-f]{16}$/;

export function isValidFingerprint(value: string): boolean {
  if (value.length > MAX_FINGERPRINT_CONTEXT_LENGTH + 17) return false; // +1 `:` + 16 hex
  return FINGERPRINT_PATTERN.test(value);
}
