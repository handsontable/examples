// Cache store: Redis primary, filesystem fallback.
//
// Exposes a small CacheStore interface:
//   get(key)              -> Promise<string | null>
//   set(key, value, ttl)  -> Promise<void>
//   del(key)              -> Promise<void>
//
// Redis is attempted first. On any read/write failure (connection refused, timeout,
// auth error, etc.) the store transparently falls back to the filesystem backend
// and logs exactly once so operators know it is running in degraded mode.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_CACHE_DIR =
  process.env.CACHE_DIR ||
  path.join(process.cwd(), ".changelog-prs-cache");

function safeFileNameForKey(key) {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash}.json`;
}

class FileCacheStore {
  constructor(dir = DEFAULT_CACHE_DIR) {
    this.dir = dir;
    this.ready = this._ensureDir();
  }

  async _ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  _pathFor(key) {
    return path.join(this.dir, safeFileNameForKey(key));
  }

  async get(key) {
    await this.ready;
    const file = this._pathFor(key);
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const { v, exp } = parsed;
      if (typeof exp === "number" && exp > 0 && Date.now() > exp) {
        // Best-effort cleanup; ignore errors
        fs.unlink(file).catch(() => {});
        return null;
      }
      return typeof v === "string" ? v : null;
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    await this.ready;
    const file = this._pathFor(key);
    const exp =
      typeof ttlSeconds === "number" && ttlSeconds > 0
        ? Date.now() + ttlSeconds * 1000
        : 0;
    const body = JSON.stringify({ v: value, exp });
    const tmp = path.join(
      this.dir,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${path.basename(file)}`,
    );
    try {
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, file);
    } catch (err) {
      try { await fs.unlink(tmp); } catch {}
      throw err;
    }
  }

  async del(key) {
    await this.ready;
    try {
      await fs.unlink(this._pathFor(key));
    } catch {}
  }
}

class RedisCacheStore {
  constructor(client) {
    this.client = client;
  }

  async get(key) {
    const v = await this.client.get(key);
    return v ?? null;
  }

  async set(key, value, ttlSeconds) {
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      await this.client.set(key, value, "EX", Math.max(1, Math.floor(ttlSeconds)));
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key) {
    await this.client.del(key);
  }
}

/**
 * Composite cache: Redis primary with permanent file fallback on any failure.
 * After the first Redis error, all subsequent ops go directly to the file store
 * until process restart. Writes that Redis accepts are NOT mirrored to disk —
 * Redis is the source of truth in healthy mode, files only exist as the degraded
 * path. This matches the intent of the edge function's Cache API layering.
 */
class CompositeCacheStore {
  constructor({ redis, file, onDegraded }) {
    this.redis = redis;
    this.file = file;
    this.onDegraded = onDegraded || (() => {});
    this.degraded = !redis;
  }

  _markDegraded(err) {
    if (this.degraded) return;
    this.degraded = true;
    try {
      this.onDegraded(err);
    } catch {}
  }

  async get(key) {
    if (this.redis && !this.degraded) {
      try {
        const v = await this.redis.get(key);
        if (v !== null && v !== undefined) return v;
        return null;
      } catch (err) {
        this._markDegraded(err);
      }
    }
    try {
      return await this.file.get(key);
    } catch {
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    if (this.redis && !this.degraded) {
      try {
        await this.redis.set(key, value, ttlSeconds);
        return;
      } catch (err) {
        this._markDegraded(err);
      }
    }
    try {
      await this.file.set(key, value, ttlSeconds);
    } catch {
      // Best-effort; don't bring the request down because the cache hiccuped.
    }
  }

  async del(key) {
    if (this.redis && !this.degraded) {
      try {
        await this.redis.del(key);
      } catch (err) {
        this._markDegraded(err);
      }
    }
    try {
      await this.file.del(key);
    } catch {}
  }

  isDegraded() {
    return this.degraded;
  }
}

async function tryCreateRedisClient() {
  const url =
    process.env.REDIS_URL ||
    process.env.REDIS_CONNECTION_STRING ||
    "";
  if (!url) return null;

  let IORedis;
  try {
    ({ default: IORedis } = await import("ioredis"));
  } catch (err) {
    console.warn(
      "[changelog-prs] ioredis not installed; falling back to file cache. Run: npm i ioredis",
    );
    return null;
  }

  const client = new IORedis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });

  client.on("error", (err) => {
    // ioredis emits errors proactively; swallow them here so they don't crash.
    // Actual request-level handling happens in CompositeCacheStore via try/catch.
    if (!client.__warnedOnce) {
      client.__warnedOnce = true;
      console.warn("[changelog-prs] redis error:", err?.message || err);
    }
  });

  try {
    await client.connect();
    await client.ping();
    return new RedisCacheStore(client);
  } catch (err) {
    console.warn(
      "[changelog-prs] redis unavailable, using file cache:",
      err?.message || err,
    );
    try { client.disconnect(); } catch {}
    return null;
  }
}

/**
 * Build the composite cache store. Safe to call once at startup and share across
 * requests. The returned instance exposes { get, set, del, isDegraded }.
 */
export async function createCacheStore({ cacheDir } = {}) {
  const file = new FileCacheStore(cacheDir || DEFAULT_CACHE_DIR);
  await file.ready;

  const redis = await tryCreateRedisClient();

  const store = new CompositeCacheStore({
    redis,
    file,
    onDegraded: (err) => {
      console.warn(
        "[changelog-prs] cache degraded to file-only backend:",
        err?.message || err,
      );
    },
  });

  if (!redis) {
    console.log(
      `[changelog-prs] cache: file-only backend at ${file.dir}` +
        (process.env.REDIS_URL ? " (redis probe failed)" : " (no REDIS_URL set)"),
    );
  } else {
    console.log("[changelog-prs] cache: redis primary + file fallback ready");
  }

  return store;
}

// Exposed for tests / advanced wiring
export { FileCacheStore, RedisCacheStore, CompositeCacheStore };
