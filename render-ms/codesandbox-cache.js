// Cache helpers for /codesandbox-vm and /codesandbox-browser.
//
// Wraps the cold-path GitHub + npm calls in a CompositeCacheStore-backed cache
// so repeat requests skip redundant network I/O. Also exposes an in-memory
// coalescer that collapses concurrent identical requests into a single upstream
// fetch — useful when the cache is cold and N tabs hit the service at once.
//
// All cache writes are best-effort: a failure to read or write the cache must
// never break the request. The store is the same CompositeCacheStore created
// by ./changelog-prs/cache.js (Redis primary, file fallback).

import { Buffer } from "node:buffer";
import { fetchFiles as fetchFilesUncached } from "./github.js";
import { getVersion as getVersionUncached } from "./version.js";
import { validateExampleDirExistsInRepo as validateExampleDirExistsInRepoUncached } from "./validate-query-params.js";

const KEY_PREFIX = "csb-vm:";

// TTLs (seconds)
const EXISTS_TTL_SEC = 10 * 60;
const VERSION_LATEST_TTL_SEC = 60;
const VERSION_BRANCH_TTL_SEC = 5 * 60;
const VERSION_SHA_TTL_SEC = 30 * 24 * 60 * 60;
const TIP_SHA_TTL_SEC = 60;
const FILES_TTL_SEC = 30 * 24 * 60 * 60;
const SANDBOX_ID_TTL_SEC = 24 * 60 * 60;
// Redis values larger than this go to file-only storage (mirrors changelog-prs
// behavior for bulk PR payloads). Some example dirs have multi-MB lockfiles
// which we do NOT want to ship to a managed Redis with a small value cap.
const FILES_REDIS_MAX_BYTES = 5_000_000;

const slug = (v) => (v === undefined || v === null || v === "" ? "-" : String(v));

export function buildSandboxCacheKeys({
  exampleDir,
  exampleBranch,
  handsontableVersion,
  handsontableBranch,
  handsontableSha,
  pkgPrNew,
  resolvedVersion,
}) {
  const flavor = pkgPrNew ? "pp" : "reg";
  const raw = `${KEY_PREFIX}sb-raw:v1/${slug(exampleDir)}/${slug(exampleBranch)}/${slug(handsontableVersion)}/${slug(handsontableBranch)}/${slug(handsontableSha)}/${flavor}`;
  const resolved = resolvedVersion
    ? `${KEY_PREFIX}sb:v1/${slug(exampleDir)}/${slug(exampleBranch)}/${slug(resolvedVersion)}/${flavor}`
    : null;
  return { raw, resolved };
}

async function getJson(cache, key) {
  if (!cache) return null;
  try {
    const raw = await cache.get(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function putJsonAsync(cache, key, value, ttlSec, opts) {
  if (!cache) return;
  const body = safeStringify(value);
  if (body == null) return;
  setImmediate(() => {
    cache.set(key, body, ttlSec, opts).catch((err) => {
      console.warn(`[csb-vm] cache put failed ${key}:`, err?.message || err);
    });
  });
}

// Sandbox ID cache ----------------------------------------------------------

export async function readCachedSandboxId(cache, keys, opts = {}) {
  if (!cache) return null;
  if (opts.bypass) {
    console.log(`[csb-cache] sandbox-id BYPASS (nocache)`);
    return null;
  }
  for (const k of [keys.raw, keys.resolved]) {
    if (!k) continue;
    const start = Date.now();
    try {
      const raw = await cache.get(k);
      const elapsed = Date.now() - start;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.id === "string" && parsed.id) {
          console.log(`[csb-cache] sandbox-id HIT ${k} -> ${parsed.id} (${elapsed}ms)`);
          return parsed.id;
        }
      }
      console.log(`[csb-cache] sandbox-id MISS ${k} (${elapsed}ms)`);
    } catch (err) {
      console.warn(
        `[csb-cache] sandbox-id GET error ${k} after ${Date.now() - start}ms: ${err?.message || err}`,
      );
    }
  }
  return null;
}

export function writeCachedSandboxId(cache, keys, id) {
  if (!cache || !id) return;
  const payload = { id, ts: Date.now() };
  if (keys.raw) putJsonAsync(cache, keys.raw, payload, SANDBOX_ID_TTL_SEC);
  if (keys.resolved) putJsonAsync(cache, keys.resolved, payload, SANDBOX_ID_TTL_SEC);
}

export function invalidateCachedSandboxId(cache, keys) {
  if (!cache) return;
  for (const k of [keys.raw, keys.resolved]) {
    if (!k) continue;
    cache.del(k).catch(() => {});
  }
}

// validateExampleDirExistsInRepo wrapper ------------------------------------

export async function cachedValidateExampleDirExistsInRepo(
  cache,
  octokit,
  exampleDir,
  exampleBranch,
  opts = {},
) {
  const key = `${KEY_PREFIX}exists:v1/${slug(exampleDir)}/${slug(exampleBranch)}`;
  if (opts.bypass) {
    console.log(`[csb-cache] exists BYPASS ${exampleDir}@${exampleBranch || "default"}`);
  }
  const cached = opts.bypass ? null : await getJson(cache, key);
  if (cached?.ok === true) {
    console.log(`[csb-cache] exists HIT ${exampleDir}@${exampleBranch || "default"}`);
    return { ok: true };
  }
  console.log(
    `[csb-cache] exists MISS ${exampleDir}@${exampleBranch || "default"} — calling GitHub …`,
  );
  const start = Date.now();
  const fresh = await validateExampleDirExistsInRepoUncached(
    octokit,
    exampleDir,
    exampleBranch,
  );
  console.log(
    `[csb-cache] exists GitHub call ${Date.now() - start}ms ok=${fresh.ok}`,
  );
  if (fresh.ok) {
    putJsonAsync(cache, key, { ok: true }, EXISTS_TTL_SEC);
  }
  return fresh;
}

// getVersion wrapper --------------------------------------------------------

export async function cachedGetVersion(
  cache,
  octokit,
  handsontableBranch,
  handsontableVersion,
  handsontableSha,
  opts = {},
) {
  if (handsontableVersion) {
    console.log(`[csb-cache] version PASSTHROUGH ${handsontableVersion}`);
    return handsontableVersion;
  }

  let ttl;
  if (handsontableSha) {
    ttl = VERSION_SHA_TTL_SEC;
  } else if (handsontableBranch) {
    ttl = VERSION_BRANCH_TTL_SEC;
  } else {
    ttl = VERSION_LATEST_TTL_SEC;
  }
  const key = `${KEY_PREFIX}ver:v1/${slug(handsontableBranch)}/${slug(handsontableSha)}`;

  if (opts.bypass) {
    console.log(
      `[csb-cache] version BYPASS branch=${handsontableBranch || "-"} sha=${handsontableSha || "-"}`,
    );
  }
  const cached = opts.bypass ? null : await getJson(cache, key);
  if (cached && typeof cached.v === "string" && cached.v) {
    console.log(
      `[csb-cache] version HIT branch=${handsontableBranch || "-"} sha=${handsontableSha || "-"} -> ${cached.v}`,
    );
    return cached.v;
  }

  console.log(
    `[csb-cache] version MISS branch=${handsontableBranch || "-"} sha=${handsontableSha || "-"} — resolving …`,
  );
  const start = Date.now();
  const v = await getVersionUncached(
    octokit,
    handsontableBranch,
    handsontableVersion,
    handsontableSha,
  );
  console.log(`[csb-cache] version resolved ${Date.now() - start}ms -> ${v}`);

  if (typeof v === "string" && v && v !== "latest") {
    putJsonAsync(cache, key, { v }, ttl);
  }
  return v;
}

// fetchFiles wrapper --------------------------------------------------------
//
// Strategy: resolve the ref to a tip SHA (cheap — single API call, also briefly
// cached) and key the file payload by that SHA so the cached blob is immutable.
// On hit we skip the recursive getContent + per-file getBlob avalanche entirely.

async function resolveTipShaCached(cache, octokit, owner, repo, ref, opts = {}) {
  const key = `${KEY_PREFIX}tip:v1/${slug(owner)}/${slug(repo)}/${slug(ref)}`;
  if (opts.bypass) {
    console.log(
      `[csb-cache] tip-sha BYPASS ${owner}/${repo}@${ref || "HEAD"}`,
    );
  }
  const cached = opts.bypass ? null : await getJson(cache, key);
  if (cached && typeof cached.sha === "string" && cached.sha) {
    console.log(`[csb-cache] tip-sha HIT ${owner}/${repo}@${ref || "HEAD"} = ${cached.sha.slice(0, 7)}`);
    return cached.sha;
  }

  const start = Date.now();
  try {
    const params = { owner, repo, ref: ref || "HEAD" };
    const { data } = await octokit.rest.repos.getCommit(params);
    const sha = data?.sha;
    if (typeof sha === "string" && sha) {
      console.log(
        `[csb-cache] tip-sha MISS ${owner}/${repo}@${ref || "HEAD"} = ${sha.slice(0, 7)} (${Date.now() - start}ms)`,
      );
      putJsonAsync(cache, key, { sha }, TIP_SHA_TTL_SEC);
      return sha;
    }
  } catch (err) {
    console.warn(
      `[csb-cache] tip-sha ERROR ${owner}/${repo}@${ref || "HEAD"} after ${Date.now() - start}ms: ${err?.message || err}`,
    );
  }
  return null;
}

export async function cachedFetchFiles(
  cache,
  octokit,
  owner,
  repo,
  directory,
  options = {},
  opts = {},
) {
  const ref = options.ref;
  const tipShaStart = Date.now();
  const tipSha = await resolveTipShaCached(cache, octokit, owner, repo, ref, opts);
  console.log(
    `[csb-cache] resolveTipSha total ${Date.now() - tipShaStart}ms (sha=${tipSha ? tipSha.slice(0, 7) : "none"})`,
  );

  if (tipSha) {
    const filesKey = `${KEY_PREFIX}files:v1/${slug(owner)}/${slug(repo)}/${slug(directory)}/${tipSha}`;
    if (opts.bypass) {
      console.log(`[csb-cache] files BYPASS ${directory}@${tipSha.slice(0, 7)}`);
    }
    const cacheReadStart = Date.now();
    const cached = opts.bypass ? null : await getJson(cache, filesKey);
    console.log(
      `[csb-cache] files cache get ${Date.now() - cacheReadStart}ms hit=${!!cached}`,
    );
    if (cached && Array.isArray(cached.files)) {
      console.log(
        `[csb-cache] files HIT ${directory}@${tipSha.slice(0, 7)} (${cached.files.length} files)`,
      );
      return cached.files.map((f) => ({
        path: f.path,
        text: f.text || "",
        contents: f.text ? Buffer.from(f.text, "utf-8") : null,
      }));
    }

    console.log(
      `[csb-cache] files MISS ${directory}@${tipSha.slice(0, 7)} — fetching from GitHub …`,
    );
    const fetchStart = Date.now();
    const fresh = await fetchFilesUncached(octokit, owner, repo, directory, {
      ...options,
      ref: tipSha,
    });
    console.log(
      `[csb-cache] fetchFilesUncached returned ${fresh.length} files in ${Date.now() - fetchStart}ms`,
    );

    const serializable = fresh.map((f) => ({ path: f.path, text: f.text || "" }));
    const body = safeStringify({ files: serializable });
    if (body != null) {
      const preferFile = body.length > FILES_REDIS_MAX_BYTES;
      console.log(
        `[csb-cache] files cache put ${(body.length / 1024).toFixed(1)}KB preferFile=${preferFile}`,
      );
      setImmediate(() => {
        cache
          ?.set(filesKey, body, FILES_TTL_SEC, { preferFile })
          .catch((err) => {
            console.warn(
              `[csb-vm] files cache put failed ${filesKey}:`,
              err?.message || err,
            );
          });
      });
    }
    return fresh;
  }

  console.warn(
    `[csb-cache] tip SHA unavailable — falling back to uncached recursive fetch (slow!)`,
  );
  const fallbackStart = Date.now();
  const fresh = await fetchFilesUncached(octokit, owner, repo, directory, options);
  console.log(
    `[csb-cache] uncached fetchFiles ${fresh.length} files in ${Date.now() - fallbackStart}ms`,
  );
  return fresh;
}

// In-flight coalescer ------------------------------------------------------

const inflight = new Map();

/**
 * Run `fn` exclusively per `key` within this process. Concurrent callers with
 * the same key share the same Promise. Useful to avoid creating duplicate
 * sandboxes when N requests hit a cold cache simultaneously.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function coalesce(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => fn())().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
