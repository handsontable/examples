// The minimal storage surface `InboxWriter`'s pure logic modules
// (`dedupe.ts`, `registry.ts`, `pack.ts`) need — a structural subset of
// `DurableObjectStorage`/`DurableObjectTransaction`, so a plain
// `Map`-backed fake can stand in under `node --test` (TESTING.md: "in-memory
// fakes for worker bindings", the same pattern `mcp-routes.test.mjs` uses for
// D1/KV/R2) without pulling `cloudflare:workers` into a plain Node process.
//
// `get`/`getMany` are split rather than mirroring `DurableObjectStorage`'s
// single overloaded `get(key)`/`get(keys[])` — an object literal cannot
// implement a two-signature overloaded method cleanly, and `writer.ts` (the
// real `InboxWriter` DO) adapts `this.ctx.storage` to this shape with
// `durableObjectStorageAdapter` below, a few lines of glue rather than
// fighting TypeScript's overload-assignability rules for no real benefit.

/** `start`/`end`/`limit` (F2 fix, B-C1): a real `DurableObjectStorage.list`
 *  already accepts these — added here so `ledger.ts`'s bounded-per-call
 *  pruning sweeps (`hash:`/`done:` range deletes) can ask for "at most
 *  `limit` rows in `[start, end)`" instead of a full-prefix scan, and
 *  `memoryStorage()` below honours them the same way for `node --test`.
 *  Never combined with `prefix` by any caller in this codebase (real DO
 *  behaviour when both are given together is not exercised here), so
 *  `memoryStorage()`'s combination semantics (AND of whichever are given)
 *  are untested against the real binding — only `start`/`end`/`limit`
 *  alone, or `prefix` alone, are used. */
export interface ListOptions {
  prefix?: string;
  /** Inclusive: only keys `>= start`. */
  start?: string;
  /** Exclusive: only keys `< end`. */
  end?: string;
  limit?: number;
}

export interface StorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  getMany<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  /** Always returns entries in ascending key order (matches
   *  `DurableObjectStorage.list`'s default, `reverse` never requested
   *  here). */
  list<T = unknown>(options?: ListOptions): Promise<Map<string, T>>;
  transaction<T>(closure: (txn: StorageLike) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** Cloudflare's documented SQLite-backed-DO storage-API limit (final review,
 *  finding N2): https://developers.cloudflare.com/durable-objects/api/storage-api/
 *  — "get() ... Supports up to 128 keys at a time.", "put() ... Supports up
 *  to 128 key-value pairs at a time.", "delete() ... Supports up to 128 keys
 *  at a time." (fetched 2026-09-24). Local `workerd` was observed accepting
 *  500+ keys in one call with no error, so nothing in
 *  this codebase's OWN test doubles enforced it either — every multi-key
 *  call below `DO_STORAGE_MAX_KEYS_PER_CALL` in this codebase must chunk
 *  through {@link getManyChunked}/{@link putChunked}/{@link deleteChunked}
 *  rather than calling `getMany`/`put`/`delete` directly with an unbounded
 *  key set; `memoryStorage()` (below) and `pipeline/fixtures/o11y-harness.mjs`'s
 *  `makeDurableObjectStorage` both throw above this limit so a missed call
 *  site fails a test instead of silently working locally and throwing only
 *  in production. */
export const DO_STORAGE_MAX_KEYS_PER_CALL = 128;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `storage.getMany(keys)`, chunked to {@link DO_STORAGE_MAX_KEYS_PER_CALL}
 *  per call. Safe to call with `storage` being a `transaction()` closure's
 *  own `txn` — each chunk is just another `get` call against the same
 *  in-flight transaction. */
export async function getManyChunked<T = unknown>(storage: StorageLike, keys: readonly string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (const chunk of chunks(keys, DO_STORAGE_MAX_KEYS_PER_CALL)) {
    if (chunk.length === 0) continue;
    const part = await storage.getMany<T>(chunk);
    for (const [k, v] of part) out.set(k, v);
  }
  return out;
}

/** `storage.put(entries)`, chunked to {@link DO_STORAGE_MAX_KEYS_PER_CALL}
 *  key-value pairs per call. When `storage` is a `transaction()` closure's
 *  `txn`, every chunk still commits as one atomic transaction — chunking
 *  only splits how many pairs go in each underlying `put` CALL, not the
 *  transaction boundary itself. */
export async function putChunked<T>(storage: StorageLike, entries: Record<string, T>): Promise<void> {
  const keys = Object.keys(entries);
  for (const chunk of chunks(keys, DO_STORAGE_MAX_KEYS_PER_CALL)) {
    if (chunk.length === 0) continue;
    const part: Record<string, T> = {};
    for (const k of chunk) part[k] = entries[k] as T;
    await storage.put(part);
  }
}

/** `storage.delete(keys)`, chunked to {@link DO_STORAGE_MAX_KEYS_PER_CALL}
 *  keys per call — see {@link putChunked}'s transaction-atomicity note,
 *  which applies identically here. */
export async function deleteChunked(storage: StorageLike, keys: readonly string[]): Promise<number> {
  let deleted = 0;
  for (const chunk of chunks(keys, DO_STORAGE_MAX_KEYS_PER_CALL)) {
    if (chunk.length === 0) continue;
    deleted += await storage.delete(chunk);
  }
  return deleted;
}

/** A `Map`-backed {@link StorageLike} for `node --test`. `transaction()` is a
 *  no-op wrapper (the fake has no concurrent writers to isolate from), so its
 *  only job is giving a caller that always writes inside `transaction()`
 *  something real to call — a fresh `memoryStorage()` given to a second
 *  `InboxWriter` instance is how the tests simulate a restart between an
 *  append and the alarm (exit criterion 2's "unclean stop" shape, at the
 *  storage layer). */
export function memoryStorage(): StorageLike {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;

  const self: StorageLike = {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async getMany<T>(keys: string[]): Promise<Map<string, T>> {
      if (keys.length > DO_STORAGE_MAX_KEYS_PER_CALL) {
        throw new Error(`memoryStorage().getMany: ${keys.length} keys exceeds the DO storage limit of ${DO_STORAGE_MAX_KEYS_PER_CALL} — use getManyChunked()`);
      }
      const out = new Map<string, T>();
      for (const k of keys) if (data.has(k)) out.set(k, data.get(k) as T);
      return out;
    },
    async put(entries) {
      const keys = Object.keys(entries);
      if (keys.length > DO_STORAGE_MAX_KEYS_PER_CALL) {
        throw new Error(`memoryStorage().put: ${keys.length} keys exceeds the DO storage limit of ${DO_STORAGE_MAX_KEYS_PER_CALL} — use putChunked()`);
      }
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
    async delete(keys) {
      if (keys.length > DO_STORAGE_MAX_KEYS_PER_CALL) {
        throw new Error(`memoryStorage().delete: ${keys.length} keys exceeds the DO storage limit of ${DO_STORAGE_MAX_KEYS_PER_CALL} — use deleteChunked()`);
      }
      let n = 0;
      for (const k of keys) if (data.delete(k)) n++;
      return n;
    },
    async list<T>(options?: ListOptions) {
      const matches: [string, T][] = [];
      for (const [k, v] of data) {
        if (options?.prefix && !k.startsWith(options.prefix)) continue;
        if (options?.start !== undefined && k < options.start) continue;
        if (options?.end !== undefined && k >= options.end) continue;
        matches.push([k, v as T]);
      }
      // A real `DurableObjectStorage.list` always returns ascending key
      // order; `data` (a `Map`) iterates in insertion order, which callers
      // must not rely on — sort explicitly so a fake behaves like the real
      // binding for range-delete/pagination logic (`ledger.ts#pruneLedger`).
      matches.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const limited = options?.limit !== undefined ? matches.slice(0, options.limit) : matches;
      return new Map(limited);
    },
    async transaction(closure) {
      return closure(self);
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(scheduledTime) {
      alarm = scheduledTime;
    },
  };
  return self;
}
