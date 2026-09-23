// ADR §F.3 / contract §7, §8: "The exact first-seen registry for error
// fingerprints (§F.3) is updated at [dedupe] step" — `fp:<fingerprint>` is
// written once, on first sight, and never overwritten; `feedsNewFingerprintAlert`
// (surface = `demo-runtime`) has already filtered which fingerprints even
// reach here (`normalise/faro.ts` only sets `IngestItem.fingerprint` when it
// should feed the alert).

import { fingerprintStorageKey } from "@handsontable/demo-runtime/telemetry";
import type { StorageLike } from "./storage.js";

/** Returns `key:<fp>` → `nowMs` entries for every fingerprint in
 *  `fingerprints` not already present in storage — commit these in the same
 *  transaction as the dedupe/row writes. A fingerprint present more than
 *  once in one batch is written once (the registry only cares about
 *  first-seen, not a count). */
export async function newFingerprintWrites(
  storage: StorageLike,
  fingerprints: readonly string[],
  nowMs: number,
): Promise<Record<string, number>> {
  const unique = [...new Set(fingerprints)];
  if (unique.length === 0) return {};
  const existing = await storage.getMany<number>(unique.map(fingerprintStorageKey));
  const writes: Record<string, number> = {};
  for (const fp of unique) {
    const key = fingerprintStorageKey(fp);
    if (!existing.has(key)) writes[key] = nowMs;
  }
  return writes;
}
