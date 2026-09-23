// Pure, storage-agnostic helpers for the T04 additions to `InboxWriterApi`
// (contract §8: `alert:<rule>`, `drainsPaused`, `heartbeat`, plus the
// backlog/rejected/fingerprint reads the ADR §F.3 rules need) — same pattern
// `dedupe.ts`/`registry.ts`/`pack.ts` use next to `writer.ts`: unit-testable
// over `inbox/storage.ts#memoryStorage()` without a real Durable Object
// (`pipeline/o11y-alerts.test.mjs`), and `writer.ts` only adapts these to its
// thin RPC shell.

import {
  alertStorageKey,
  DRAINS_PAUSED_STORAGE_KEY,
  fingerprintStorageKey,
  HEARTBEAT_STORAGE_KEY,
  inboxKeyStorageKey,
  parseInboxKey,
  type AlertState,
  type Heartbeat,
  type InboxKeyState,
} from "@handsontable/demo-runtime/telemetry";
import type { StorageLike } from "../inbox/storage.js";

const KEY_PREFIX = "key:";
const FP_PREFIX = "fp:";
const ALERT_META_PREFIX = "alertMeta:";

// `key:<inbox key>`/`fp:<fingerprint>` prefixes are the storage-key SHAPES
// the contract module already exports (`inboxKeyStorageKey`/
// `fingerprintStorageKey`); `.slice()` below strips exactly what those
// builders prepend, so a future prefix rename only has to change in one
// place.
const KEY_PREFIX_LEN = inboxKeyStorageKey("").length;
const FP_PREFIX_LEN = fingerprintStorageKey("").length;

export async function readHeartbeat(storage: StorageLike): Promise<Heartbeat> {
  return (await storage.get<Heartbeat>(HEARTBEAT_STORAGE_KEY)) ?? { lastCron: 0, lastIngest: 0 };
}

/** Stamps `heartbeat.lastCron`, preserving `lastIngest` — see the
 *  `InboxWriterApi.stampCronHeartbeat` doc comment for who calls this and
 *  when. */
export async function writeCronHeartbeat(storage: StorageLike, nowMs: number): Promise<void> {
  const current = await readHeartbeat(storage);
  await storage.put<Heartbeat>({ [HEARTBEAT_STORAGE_KEY]: { ...current, lastCron: nowMs } });
}

/**
 * Oldest still-`written` inbox key's age, in ms, or `null` when nothing is
 * backlogged. An inbox key only carries `<yyyy-mm-dd>/<hh>` (contract §8),
 * never a precise arrival time, so the age is measured from the END of that
 * hour (`hh:59:59.999Z`) — a deliberate lower bound (T04-D, see this task's
 * Outcome): the true key is somewhere inside that hour, so measuring from
 * its end means the backlog-age alert can only fire LATE relative to the
 * real age, never early/falsely.
 */
export async function backlogOldestAgeMs(storage: StorageLike, nowMs = Date.now()): Promise<number | null> {
  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  let oldestAgeMs: number | null = null;
  for (const [storageKey, state] of keys) {
    if (state !== "written") continue;
    const parsed = parseInboxKey(storageKey.slice(KEY_PREFIX_LEN));
    if (!parsed) continue;
    const endOfHourMs = Date.parse(`${parsed.date}T${parsed.hour}:59:59.999Z`);
    if (!Number.isFinite(endOfHourMs)) continue;
    const ageMs = nowMs - endOfHourMs;
    if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs;
  }
  return oldestAgeMs;
}

/** Count of `key:<k> = rejected:<reason>` entries (ADR §F.3's "a `rejected`
 *  inbox key" rule). */
export async function rejectedKeyCount(storage: StorageLike): Promise<number> {
  const keys = await storage.list<InboxKeyState>({ prefix: KEY_PREFIX });
  let count = 0;
  for (const [, state] of keys) {
    if (typeof state === "string" && state.startsWith("rejected:")) count++;
  }
  return count;
}

/** `fp:<fingerprint>` names first seen strictly after `sinceMs`. */
export async function newFingerprintsSince(storage: StorageLike, sinceMs: number): Promise<string[]> {
  const entries = await storage.list<number>({ prefix: FP_PREFIX });
  const names: string[] = [];
  for (const [storageKey, firstSeenMs] of entries) {
    if (typeof firstSeenMs === "number" && firstSeenMs > sinceMs) names.push(storageKey.slice(FP_PREFIX_LEN));
  }
  return names;
}

export async function readAlertState(storage: StorageLike, rule: string): Promise<AlertState | undefined> {
  return storage.get<AlertState>(alertStorageKey(rule));
}

export async function writeAlertState(storage: StorageLike, rule: string, state: AlertState): Promise<void> {
  await storage.put<AlertState>({ [alertStorageKey(rule)]: state });
}

export async function readAlertMeta(storage: StorageLike, key: string): Promise<string | undefined> {
  return storage.get<string>(`${ALERT_META_PREFIX}${key}`);
}

export async function writeAlertMeta(storage: StorageLike, key: string, value: string): Promise<void> {
  await storage.put<string>({ [`${ALERT_META_PREFIX}${key}`]: value });
}

export async function readDrainsPaused(storage: StorageLike): Promise<boolean> {
  return (await storage.get<boolean>(DRAINS_PAUSED_STORAGE_KEY)) ?? false;
}

export async function writeDrainsPaused(storage: StorageLike, paused: boolean): Promise<void> {
  await storage.put<boolean>({ [DRAINS_PAUSED_STORAGE_KEY]: paused });
}
