// Shared in-memory env for the o11y worker's tests — the same pattern
// `worker-harness.mjs` uses for `workers/api`'s D1/KV/R2 fakes (TESTING.md:
// "in-memory fakes for worker bindings"). Imports nothing from
// `workers/o11y/src/`, so it is safe to import before `o11y-worker-hooks.mjs`
// is registered (mirrors `worker-harness.mjs`'s own header note).

export const ctx = {
  waitUntil(promise) {
    // Tests await route handlers directly and then drain this queue, so a
    // `writePoint`'s `ctx.waitUntil` write lands before assertions run.
    this._pending.push(Promise.resolve(promise).catch(() => {}));
  },
  _pending: [],
  async drain() {
    await Promise.all(this._pending);
    this._pending.length = 0;
  },
};

/** A real `DurableObjectStorage`-shaped `Map` fake — the overloaded `get`
 *  branches on `Array.isArray` at runtime (plain JS, no TS overload
 *  wrangling needed here). `transaction()` calls the closure with itself, so
 *  nested `txn.get`/`.put`/`.delete`/`.list` calls hit the same backing
 *  `Map` atomically-in-spirit (single-threaded Node, no real concurrency to
 *  guard against). */
export function makeDurableObjectStorage(seed = new Map()) {
  const data = seed;
  let alarm = null;
  const storage = {
    async get(keyOrKeys) {
      if (Array.isArray(keyOrKeys)) {
        const out = new Map();
        for (const k of keyOrKeys) if (data.has(k)) out.set(k, data.get(k));
        return out;
      }
      return data.get(keyOrKeys);
    },
    async put(entries) {
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
    async delete(keys) {
      let n = 0;
      for (const k of keys) if (data.delete(k)) n++;
      return n;
    },
    async list(options) {
      const out = new Map();
      for (const [k, v] of data) {
        if (!options?.prefix || k.startsWith(options.prefix)) out.set(k, v);
      }
      return out;
    },
    async transaction(closure) {
      return closure(storage);
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(t) {
      alarm = t instanceof Date ? t.getTime() : t;
    },
    async deleteAlarm() {
      alarm = null;
    },
    _data: data,
  };
  return storage;
}

export function makeR2Bucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
    },
    async get(key) {
      const v = objects.get(key);
      if (!v) return null;
      return { body: v, async arrayBuffer() { return v.buffer; } };
    },
  };
}

export function makeAnalyticsEngine() {
  const points = [];
  return {
    points,
    writeDataPoint(point) {
      points.push(point);
    },
  };
}

const SECRET = "test-export-secret";
const SENTRY_SECRET = "test-sentry-secret";

/**
 * `InboxWriterClass` is the real `InboxWriter` (`workers/o11y/src/inbox/writer.ts`),
 * dynamically imported by the caller **after** `o11y-worker-hooks.mjs` is
 * registered (this module must not import it itself — see the header). One
 * shared `DurableObjectStorage` fake backs the constructed instance, so a
 * caller that wants to simulate a restart just constructs a second
 * `InboxWriterClass` instance over the same `doStorage`.
 */
export function makeEnv(InboxWriterClass, overrides = {}) {
  const doStorage = overrides.doStorage ?? makeDurableObjectStorage();
  const r2 = overrides.r2 ?? makeR2Bucket();
  const ae = overrides.ae ?? makeAnalyticsEngine();

  const env = {
    O11Y_ENV: "production",
    ACCESS_TEAM_DOMAIN: "handsontable.cloudflareaccess.com",
    ACCESS_AUD: "test-aud",
    GITHUB_OIDC_REPOSITORY: "handsontable/examples",
    O11Y_EXPORT_SECRET: SECRET,
    SENTRY_HOOK_SECRET: SENTRY_SECRET,
    AE_SQL_TOKEN: "test-ae-token",
    O11Y_INBOX: r2,
    O11Y_LOKI_STATE: makeR2Bucket(),
    O11Y_MAPS: makeR2Bucket(),
    RUNNER_EVENTS: ae,
    API: { fetch: async () => new Response(null, { status: 204 }) },
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides.env,
  };

  const doState = { storage: doStorage };
  const inboxWriterInstance = new InboxWriterClass(doState, env);

  env.INBOX_WRITER = {
    jurisdiction() {
      return this;
    },
    idFromName(name) {
      return { toString: () => name, name };
    },
    get() {
      return inboxWriterInstance;
    },
  };
  env.GRAFANA_BOX = {
    jurisdiction() {
      return this;
    },
    idFromName(name) {
      return { toString: () => name, name };
    },
    get() {
      throw new Error("GrafanaBox not constructed in this harness (T01's class)");
    },
  };

  return { env, doStorage, r2, ae, inboxWriterInstance };
}

export const EXPORT_SECRET = SECRET;
export const SENTRY_SECRET_HEADER_NAME = "sentry-hook-signature";
export const SENTRY_SECRET_VALUE = SENTRY_SECRET;
