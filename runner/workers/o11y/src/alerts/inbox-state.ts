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
  fingerprintTimeIndexKey,
  HEARTBEAT_STORAGE_KEY,
  inboxKeyStorageKey,
  parseInboxKey,
  type AlertState,
  type Heartbeat,
  type InboxKeyState,
} from "@handsontable/demo-runtime/telemetry";
import { fpFromFptsKey, FPTS_PREFIX } from "../inbox/registry.js";
import type { StorageLike } from "../inbox/storage.js";

const KEY_PREFIX = "key:";
const ALERT_META_PREFIX = "alertMeta:";

// `key:<inbox key>` prefix is the storage-key SHAPE the contract module
// already exports (`inboxKeyStorageKey`); `.slice()` below strips exactly
// what that builder prepends, so a future prefix rename only has to change
// in one place.
const KEY_PREFIX_LEN = inboxKeyStorageKey("").length;

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

/** How many `fpts:` rows one `newFingerprintsAfterKey` call may read — bounds
 *  the cost of the "new fingerprint" alert's own ten-minute cron tick (B-C1/
 *  A-I1 remainder, rereview.md row 13: "bound `newFingerprintsSince` so it
 *  doesn't list all of `fp:` every tick"). Generous relative to realistic
 *  per-tick fingerprint volume — truncation only matters under a sustained
 *  forged-fingerprint flood (N7), which is already a disclosed, non-blocking
 *  residual risk (rate-capping Slack posts, not this read). */
const NEW_FINGERPRINT_SCAN_LIMIT = 2000;

export interface NewFingerprintEntry {
  /** The exact `fpts:` storage key this entry was read from. The caller
   *  (`alerts/rules.ts#newFingerprintRule`) persists this verbatim as its
   *  keyset cursor so the next call resumes exactly after it — never by
   *  millisecond (re-review 2, NB1: a millisecond shared by
   *  {@link NEW_FINGERPRINT_SCAN_LIMIT} or more entries stalled the old
   *  ms-based cursor forever, because `lastMs - 1` always re-equalled the
   *  stored cursor on the next tick, so the same truncated page was read
   *  again every time). */
  key: string;
  name: string;
  firstSeenMs: number;
}

export interface NewFingerprintsPage {
  entries: NewFingerprintEntry[];
  /** `true` when the scan hit {@link NEW_FINGERPRINT_SCAN_LIMIT} — more
   *  fingerprints may exist past the last entry returned. */
  truncated: boolean;
}

/** `fp:<fingerprint>` entries read via the `fpts:` time-ordered index
 *  (`registry.ts`), strictly after `afterKey` — a bounded `start`/`end`
 *  range scan, never the full (alphabetically, not chronologically,
 *  ordered) `fp:` prefix. `afterKey === null` means "no cursor yet" (first
 *  ever call): the scan instead starts just after `fallbackSinceMs`.
 *
 *  `start` is documented as INCLUSIVE (`storage.ts#ListOptions`), so an
 *  `afterKey` is re-fetched and dropped rather than appending a separator
 *  byte to make the read exclusive — a real DO `list()`'s handling of a
 *  literal NUL byte inside `start` was never probed, so this file does not
 *  depend on it (re-review 2, NB1 fix). */
export async function newFingerprintsAfterKey(
  storage: StorageLike,
  afterKey: string | null,
  fallbackSinceMs: number,
): Promise<NewFingerprintsPage> {
  const start = afterKey ?? fingerprintTimeIndexKey(fallbackSinceMs + 1, "");
  const end = `${FPTS_PREFIX}￿`; // exclusive upper bound past every possible fpts: key
  // Ask for one extra row when resuming from a real cursor, so dropping the
  // re-fetched `afterKey` row itself still leaves a full page.
  const limit = NEW_FINGERPRINT_SCAN_LIMIT + (afterKey !== null ? 1 : 0);
  const page = await storage.list<number>({ start, end, limit });

  const entries: NewFingerprintEntry[] = [];
  for (const [storageKey, firstSeenMs] of page) {
    if (afterKey !== null && storageKey === afterKey) continue;
    entries.push({ key: storageKey, name: fpFromFptsKey(storageKey), firstSeenMs: Number(firstSeenMs) });
  }
  return { entries: entries.slice(0, NEW_FINGERPRINT_SCAN_LIMIT), truncated: page.size >= limit };
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
