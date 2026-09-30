// Global admission windows for the two write paths a forged flood can grow
// without bound: new `fp:` fingerprints and new `hash:` dedupe entries. Browser
// ingest is only rate-limited per IP, so many IPs sending well-formed unique
// values would otherwise grow DO storage until the TTL sweeps catch up (90
// days for `fp:`). One `admission:<windowStartMs>` row per 10-minute window
// counts what was admitted and what was dropped; `alerts/rules.ts` reads the
// dropped counts to raise one alert. Pure over {@link StorageLike}.

import { deleteChunked, type StorageLike } from "./storage.js";

/** Matches the ten-minute cron tick, so a tick always sees whole windows. */
export const ADMISSION_WINDOW_MS = 10 * 60 * 1000;
/** New fingerprints admitted per window. Real volume is a handful per day. */
export const FP_ADMIT_PER_WINDOW = 200;
/** New `hash:` entries admitted per window. Equals `dedupe.ts`'s per-tick
 *  prune limit, so a sustained flood cannot outrun the prune. */
export const HASH_ADMIT_PER_WINDOW = 5000;
/** Window rows are tiny; keeping an hour covers the alert lookback. */
const ADMISSION_RETENTION_MS = 60 * 60 * 1000;

const ADMISSION_PREFIX = "admission:";
const ADMISSION_TIMESTAMP_DIGITS = 15;

export interface AdmissionWindow {
  fp: number;
  fpDropped: number;
  hash: number;
  hashDropped: number;
}

const EMPTY_WINDOW: AdmissionWindow = { fp: 0, fpDropped: 0, hash: 0, hashDropped: 0 };

export function windowStartMs(nowMs: number): number {
  return Math.floor(nowMs / ADMISSION_WINDOW_MS) * ADMISSION_WINDOW_MS;
}

export function admissionKey(nowMs: number): string {
  return `${ADMISSION_PREFIX}${windowStartMs(nowMs).toString().padStart(ADMISSION_TIMESTAMP_DIGITS, "0")}`;
}

export async function readAdmissionWindow(storage: StorageLike, nowMs: number): Promise<AdmissionWindow> {
  return { ...EMPTY_WINDOW, ...(await storage.get<AdmissionWindow>(admissionKey(nowMs))) };
}

/** Dropped counts summed over every window starting at or after the window
 *  holding `sinceMs`. A bounded range read: at most one hour of windows exist. */
export async function admissionDroppedSince(
  storage: StorageLike,
  sinceMs: number,
): Promise<{ fpDropped: number; hashDropped: number }> {
  const rows = await storage.list<AdmissionWindow>({
    start: admissionKey(sinceMs),
    end: `${ADMISSION_PREFIX}￿`,
  });
  let fpDropped = 0;
  let hashDropped = 0;
  for (const [, window] of rows) {
    fpDropped += window.fpDropped ?? 0;
    hashDropped += window.hashDropped ?? 0;
  }
  return { fpDropped, hashDropped };
}

/** Deletes window rows past retention, oldest first. Bounded by the
 *  retention itself: at most six live rows plus whatever a quiet gap left. */
export async function pruneAdmissionWindows(storage: StorageLike, nowMs: number): Promise<number> {
  const stale = await storage.list<AdmissionWindow>({
    start: ADMISSION_PREFIX,
    end: admissionKey(nowMs - ADMISSION_RETENTION_MS),
    limit: 1000,
  });
  const keys = [...stale.keys()];
  if (keys.length > 0) await deleteChunked(storage, keys);
  return keys.length;
}
