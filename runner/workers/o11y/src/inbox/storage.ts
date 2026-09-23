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

export interface StorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  getMany<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  transaction<T>(closure: (txn: StorageLike) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
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
      const out = new Map<string, T>();
      for (const k of keys) if (data.has(k)) out.set(k, data.get(k) as T);
      return out;
    },
    async put(entries) {
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
    async delete(keys) {
      let n = 0;
      for (const k of keys) if (data.delete(k)) n++;
      return n;
    },
    async list<T>(options?: { prefix?: string }) {
      const out = new Map<string, T>();
      for (const [k, v] of data) {
        if (!options?.prefix || k.startsWith(options.prefix)) out.set(k, v as T);
      }
      return out;
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
