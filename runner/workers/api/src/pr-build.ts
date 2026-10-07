// Demos pinned to a pull request's pkg.pr.new preview (DEV-3338).
//
// A PR number names whatever commit the PR has *now*, so a build keyed on the
// number alone is served forever after the PR moves on. The build cache key and
// the installed dependency both carry the commit instead (`pr-refresh.ts` is the
// view-time half).

import { validateHandsontableVersion } from "@handsontable/demo-runtime";
import type { Env } from "./env.js";

const PKG_PR_NEW = "https://pkg.pr.new";

/** KV's floor; one HEAD per PR per minute however many demos or viewers. */
const SHA_TTL_SECONDS = 60;
const HEAD_TIMEOUT_MS = 3000;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** The PR number a stored ref names, or null for anything that cannot move. */
export function prNumber(htVersion: string): string | null {
  const v = validateHandsontableVersion(htVersion);
  return v.ok && v.value.pkgPrNew && /^\d+$/.test(v.value.ref) ? v.value.ref : null;
}

/**
 * The commit `https://pkg.pr.new/handsontable@<pr>` serves right now, from its
 * `x-commit-key` header (`handsontable:handsontable:<sha>`). Null when
 * pkg.pr.new cannot say, which callers treat as "build what the number gives".
 * `fresh` skips the KV copy, which another colo may still hold from an older commit.
 */
export async function latestPrSha(env: Env, pr: string, opts: { fresh?: boolean } = {}): Promise<string | null> {
  const key = `prsha:${pr}`;
  if (!opts.fresh) {
    const cached = await env.CACHE.get(key);
    if (cached) return cached;
  }
  let sha: string | undefined;
  try {
    const res = await fetch(`${PKG_PR_NEW}/handsontable@${pr}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    sha = res.headers.get("x-commit-key")?.split(":").pop()?.toLowerCase();
  } catch {
    return null;
  }
  if (!sha || !SHA_RE.test(sha)) return null;
  await env.CACHE.put(key, sha, { expirationTtl: SHA_TTL_SECONDS });
  return sha;
}

/** The commit a build of `htVersion` should install: the given one, or the PR's latest. */
export async function resolvePrSha(env: Env, htVersion: string, given?: string | null): Promise<string | null> {
  if (given !== undefined) return given;
  const pr = prNumber(htVersion);
  return pr ? latestPrSha(env, pr, { fresh: true }) : null;
}

/** The version half of a build cache key: the same artifact only for the same commit. */
export function cacheRef(htVersion: string, sha: string | null): string {
  return sha ? `${htVersion}@${sha}` : htVersion;
}

/** The file map the container installs: every `pkg.pr.new/<pkg>@<pr>` dependency pinned to `sha`. */
export function pinPrFiles(files: Record<string, string>, pr: string, sha: string): Record<string, string> {
  const raw = files["/package.json"];
  if (raw === undefined) return files;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return files;
  }
  let changed = false;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field] as Record<string, unknown> | undefined;
    if (!deps || typeof deps !== "object") continue;
    for (const [name, value] of Object.entries(deps)) {
      if (value === `${PKG_PR_NEW}/${name}@${pr}`) {
        deps[name] = `${PKG_PR_NEW}/${name}@${sha}`;
        changed = true;
      }
    }
  }
  return changed ? { ...files, "/package.json": JSON.stringify(pkg, null, 2) } : files;
}
