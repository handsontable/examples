// Rebuild a PR-pinned demo when its PR moves on (DEV-3338): opening the demo
// compares the PR's current commit with the one its artifact was built from.

import type { Env } from "./env.js";
import { latestPrSha, prNumber } from "./pr-build.js";
import { demoBuildState, invalidateDemo, STALE_BUILD_MS, type DemoRow } from "./share.js";
import { scheduleSnapshotBuild } from "./snapshot-jobs.js";

export interface PrRefresh {
  pr: string;
  sha: string;
}

interface BuildColumns {
  ht_version: string;
  build_status: string | null;
  updated_at: string;
  ht_built_sha: string | null;
  ht_attempt_sha: string | null;
}

const readColumns = (env: Env, id: string) =>
  env.DB.prepare("SELECT ht_version, build_status, updated_at, ht_built_sha, ht_attempt_sha FROM demos WHERE id = ?")
    .bind(id).first<BuildColumns>();

/**
 * Called on a document view of a stored demo. Returns the refresh the viewer
 * should wait for, or null to serve the artifact as it is.
 *
 * Decided against D1 rather than the KV-cached row: a cached row can predate the
 * rebuild that just finished or a switch off the PR, and the claim below must be
 * atomic so two viewers cannot start two builds. A commit already attempted is
 * never claimed again, so a commit that fails to build costs one container, not
 * one per view.
 */
export async function refreshPrDemo(
  env: Env,
  row: DemoRow,
  opts: { budgetDenied: () => Promise<boolean>; recordBuild: () => Promise<void> },
): Promise<PrRefresh | null> {
  if (!prNumber(row.ht_version)) return null;
  const cols = await readColumns(env, row.id);
  const pr = cols ? prNumber(cols.ht_version) : null;
  if (!cols || !pr) return null;

  const refreshing = (c: BuildColumns): PrRefresh | null =>
    demoBuildState(c, Date.now()) === "building" && c.ht_attempt_sha !== null && c.ht_attempt_sha !== c.ht_built_sha
      ? { pr, sha: c.ht_attempt_sha }
      : null;
  if (demoBuildState(cols, Date.now()) === "building") return refreshing(cols);

  const settled = (sha: string | null) => !sha || sha === cols.ht_built_sha || sha === cols.ht_attempt_sha;
  let sha = await latestPrSha(env, pr);
  if (settled(sha)) return null;
  // Confirm before building: a stale KV copy must not rebuild a demo backwards.
  sha = await latestPrSha(env, pr, { fresh: true });
  if (settled(sha) || !sha) return null;
  if (await opts.budgetDenied()) return null;

  const now = new Date().toISOString();
  const claim = await env.DB.prepare(
    `UPDATE demos SET build_status='building', build_error=NULL, ht_attempt_sha=?, updated_at=?
     WHERE id=? AND (build_status!='building' OR updated_at<?) AND COALESCE(ht_attempt_sha,'')!=? AND ht_version=?`,
  ).bind(sha, now, row.id, new Date(Date.now() - STALE_BUILD_MS).toISOString(), sha, cols.ht_version).run();
  if (claim.meta?.changes !== 1) {
    // Another view claimed it first; wait for that build like its own viewer does.
    const latest = await readColumns(env, row.id);
    return latest ? refreshing(latest) : null;
  }
  await invalidateDemo(env, row.id);

  try {
    await scheduleSnapshotBuild(env, {
      demoId: row.id,
      framework: row.framework,
      htVersion: cols.ht_version,
      filesKey: `${row.r2_prefix}__source.json`,
      prSha: sha,
    });
  } catch (err) {
    // Undo the claim so the next view tries again, and keep serving the old build.
    console.warn(`[pr-build] could not schedule a refresh of ${row.id}:`, err);
    await env.DB.prepare("UPDATE demos SET build_status=?, ht_attempt_sha=?, updated_at=? WHERE id=?")
      .bind(cols.build_status ?? "ready", cols.ht_attempt_sha, cols.updated_at, row.id).run();
    await invalidateDemo(env, row.id);
    return null;
  }
  await opts.recordBuild();
  return { pr, sha };
}
