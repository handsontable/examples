// ADR §B.2 step 4: "Deduplicate in `InboxWriter`: each hash is checked
// against a 24-hour set in DO storage; a record already seen is dropped."
// Pure over a {@link StorageLike}, so it is unit-testable without a real DO
// (`pipeline/o11y-inbox.test.mjs`) and reusable from the real `InboxWriter`.

import { DEDUPE_WINDOW_MS, hashStorageKey } from "@handsontable/demo-runtime/telemetry";
import type { StorageLike } from "./storage.js";

export interface DedupeResult {
  /** Hashes that are duplicates — already seen within the 24 h window, or
   *  repeated within this same batch (a request that includes the same
   *  record twice, e.g. a client-side retry folded into one POST). */
  duplicates: ReadonlySet<string>;
  /** `hash:<sha256>` entries to write for every non-duplicate hash — the
   *  caller commits these in the same transaction as the rows/fingerprints
   *  (ADR §B.2: "the same transaction as `key:<key> = written`"). */
  writes: Readonly<Record<string, number>>;
}

/** Checks `hashes` (in order — a within-batch repeat keeps only its first
 *  occurrence as non-duplicate) against `storage`'s 24 h `hash:<sha256>`
 *  window. Read-only: does **not** write anything itself, so a caller that
 *  decides not to commit (an error later in the same request) never leaves a
 *  hash marked seen for a record that was never actually stored. */
export async function checkDuplicates(
  storage: StorageLike,
  hashes: readonly string[],
  nowMs: number,
): Promise<DedupeResult> {
  const uniqueHashes = [...new Set(hashes)];
  const existing = await storage.getMany<number>(uniqueHashes.map(hashStorageKey));

  const duplicates = new Set<string>();
  const writes: Record<string, number> = {};
  const acceptedThisBatch = new Set<string>();

  for (const hash of hashes) {
    if (acceptedThisBatch.has(hash)) {
      duplicates.add(hash);
      continue;
    }
    const firstSeen = existing.get(hashStorageKey(hash));
    const withinWindow = firstSeen !== undefined && nowMs - firstSeen < DEDUPE_WINDOW_MS;
    if (withinWindow) {
      duplicates.add(hash);
    } else {
      writes[hashStorageKey(hash)] = nowMs;
      acceptedThisBatch.add(hash);
    }
  }

  return { duplicates, writes };
}
