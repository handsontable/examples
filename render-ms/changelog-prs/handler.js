// Node.js / Express port of netlify/edge-functions/changelog-prs.mts.
//
// The .mts file in handsontable.com-v2 is the authoritative spec: URLs, TTLs,
// HTML/CSS, pagination rules, concurrency, retry, and the "cacheable" predicate
// mirror it 1:1. Only the caching substrate changes: instead of the Netlify
// Cache API we use a CacheStore (Redis primary, file fallback) passed in from
// the app so the service still works when Redis is unreachable.
//
// Background writes use setImmediate fire-and-forget (no context.waitUntil in
// plain Node). The HTTP response is returned before the write resolves so the
// "fast repeat" behavior of the edge version is preserved.

import { createHash } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const REPO = "handsontable/handsontable";
const CHANGELOG_RAW_BASE = `https://raw.githubusercontent.com/${REPO}/refs/heads/develop/.changelogs`;

const KEY_PREFIX = "changelog-prs:";
const META_KEY = (suffix) => `${KEY_PREFIX}meta:${suffix}`;
const BULK_KEY = (tag, sig) =>
  `${KEY_PREFIX}bulk:v1/${encodeURIComponent(tag)}/${sig}`;
const PAGE_KEY = (tag, developHead, tipSha, sig) =>
  `${KEY_PREFIX}page:v1/${encodeURIComponent(tag)}/${developHead || "-"}/${tipSha || "-"}/${sig}`;

const DAY_SEC = 86_400;
const BULK_CACHE_TTL_SEC = 60 * DAY_SEC;
const RELEASE_META_TTL_SEC = 5 * 60;
const COMPARE_META_TTL_SEC = 60 * DAY_SEC;
const IN_RELEASE_META_TTL_SEC = 60 * DAY_SEC;
const PAGE_HTML_TTL_SEC = 120;
const BULK_MAX_BYTES = 4_500_000;

const AREA_ORDER = ["library", "wrappers", "docs", "devops/other"];

const htmlHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
};

const htmlErrorHeaders = {
  "Content-Type": "text/html; charset=utf-8",
};

const corsPreflightHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- GitHub fetch helpers ---------------------------------------------------

function githubFetch(path, init) {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/vnd.github.v3+json");
  headers.set("User-Agent", "handsontable-changelog-prs-service");
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${GITHUB_API}${path}`, { ...init, headers });
}

function githubFetchDiff(path) {
  const headers = new Headers();
  headers.set("Accept", "application/vnd.github.diff");
  headers.set("User-Agent", "handsontable-changelog-prs-service");
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${GITHUB_API}${path}`, { headers });
}

function isTransientHttpStatus(status) {
  return (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    status === 503 ||
    (status >= 500 && status < 600)
  );
}

// --- Cache helpers ----------------------------------------------------------

async function getJson(cache, key) {
  try {
    const raw = await cache.get(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget cache write. We respond to the client first, then persist.
 * Errors are logged but never bubble up.
 */
function putJsonAsync(cache, key, value, ttlSec) {
  const body = safeStringify(value);
  if (body == null) return;
  setImmediate(() => {
    cache.set(key, body, ttlSec).catch((err) => {
      console.error("[changelog-prs] cache put failed", key, err?.message || err);
    });
  });
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    console.error("[changelog-prs] JSON.stringify failed", err?.message || err);
    return null;
  }
}

// --- Pagination: compare tag...develop --------------------------------------

async function fetchCompareCommitsAllPages(tag) {
  const perPage = 100;
  const all = [];
  const seenSha = new Set();
  let totalCommits = 0;
  const maxPages = 100;
  let page = 1;

  while (page <= maxPages) {
    const path = `/repos/${REPO}/compare/${encodeURIComponent(tag)}...develop?per_page=${perPage}&page=${page}`;
    const res = await githubFetch(path);
    if (!res.ok) {
      if (page === 1) {
        return { commits: [], totalCommits: 0, ok: false, status: res.status };
      }
      break;
    }
    const data = await res.json();
    if (page === 1) totalCommits = data.total_commits ?? 0;
    const chunk = data.commits ?? [];
    if (chunk.length === 0) break;
    for (const c of chunk) {
      if (!seenSha.has(c.sha)) {
        seenSha.add(c.sha);
        all.push(c);
      }
    }
    if (chunk.length < perPage) break;
    if (totalCommits > 0 && all.length >= totalCommits) break;
    page += 1;
  }

  return {
    commits: all,
    totalCommits: totalCommits > 0 ? totalCommits : all.length,
    ok: true,
    status: 200,
  };
}

async function getDevelopHeadSha() {
  const res = await githubFetch(
    `/repos/${REPO}/commits?sha=develop&per_page=1`,
  );
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0].sha ?? null;
}

async function getRefTipSha(ref) {
  const res = await githubFetch(
    `/repos/${REPO}/commits/${encodeURIComponent(ref)}`,
  );
  if (!res.ok) return null;
  const j = await res.json();
  return j.sha ?? null;
}

// --- Cached accessors -------------------------------------------------------

async function loadLatestReleaseCached(cache) {
  const key = META_KEY("releases/latest");
  const cached = await getJson(cache, key);
  if (cached?.release?.tag_name) return { ok: true, release: cached.release };

  const res = await githubFetch(`/repos/${REPO}/releases/latest`);
  const body = await res.text();
  if (!res.ok) return { ok: false, status: res.status, body };
  const release = JSON.parse(body);
  putJsonAsync(cache, key, { release }, RELEASE_META_TTL_SEC);
  return { ok: true, release };
}

async function fetchCompareCommitsCached(tag, developHead, cache) {
  if (!developHead) return fetchCompareCommitsAllPages(tag);
  const key = META_KEY(`compare/${encodeURIComponent(tag)}/${developHead}`);
  const cached = await getJson(cache, key);
  if (cached?.commits && Array.isArray(cached.commits)) {
    return {
      commits: cached.commits,
      totalCommits: cached.totalCommits ?? cached.commits.length,
      ok: true,
      status: 200,
    };
  }
  const fresh = await fetchCompareCommitsAllPages(tag);
  if (fresh.ok && fresh.commits.length > 0) {
    putJsonAsync(
      cache,
      key,
      { commits: fresh.commits, totalCommits: fresh.totalCommits },
      COMPARE_META_TTL_SEC,
    );
  }
  return fresh;
}

async function fetchPRsOnReleaseCached(tag, cache) {
  const tip = await getRefTipSha(tag);
  if (tip) {
    const key = META_KEY(
      `in-release/${encodeURIComponent(tag)}/${tip}`,
    );
    const cached = await getJson(cache, key);
    if (cached?.entries && Array.isArray(cached.entries)) {
      return { map: new Map(cached.entries), tipSha: tip };
    }
  }
  const map = await fetchPRsOnRelease(tag);
  if (tip) {
    const key = META_KEY(
      `in-release/${encodeURIComponent(tag)}/${tip}`,
    );
    putJsonAsync(
      cache,
      key,
      { entries: [...map.entries()] },
      IN_RELEASE_META_TTL_SEC,
    );
  }
  return { map, tipSha: tip };
}

// --- PR bulk payload --------------------------------------------------------

async function fetchChangelog(prNumber) {
  const url = `${CHANGELOG_RAW_BASE}/${prNumber}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "handsontable-changelog-prs-service" },
  });
  if (!res.ok) return null;
  try {
    const data = await res.json();
    if (data && typeof data.title === "string" && typeof data.type === "string") {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

function signatureForPRList(prNumbers) {
  const line = [...prNumbers].sort((a, b) => a - b).join(",");
  const digest = createHash("sha256").update(line).digest();
  return digest.subarray(0, 14).toString("hex");
}

async function fetchOnePRImmutable(prNumber) {
  try {
    const [pullRes, diffRes, changelog] = await Promise.all([
      githubFetch(`/repos/${REPO}/pulls/${prNumber}`),
      githubFetchDiff(`/repos/${REPO}/pulls/${prNumber}`),
      fetchChangelog(prNumber),
    ]);
    if (!pullRes.ok) {
      if (pullRes.status === 404) return { status: "skip" };
      if (isTransientHttpStatus(pullRes.status)) return { status: "transient" };
      return { status: "skip" };
    }
    let pr;
    try {
      pr = await pullRes.json();
    } catch {
      return { status: "transient" };
    }
    if (pr.state !== "closed" || !pr.merged_at) return { status: "skip" };
    if (!diffRes.ok && isTransientHttpStatus(diffRes.status)) {
      return { status: "transient" };
    }
    const diffText = diffRes.ok ? await diffRes.text() : "";
    return {
      status: "ok",
      row: {
        number: pr.number,
        title: pr.title,
        merged_at: pr.merged_at,
        html_url: pr.html_url,
        author: pr.user?.login ?? null,
        diff: diffText,
        changelog,
      },
    };
  } catch {
    return { status: "transient" };
  }
}

async function buildBulkPayload(prNumbers) {
  const CONCURRENCY = 6;

  async function fetchResults(nums) {
    const map = new Map();
    for (let i = 0; i < nums.length; i += CONCURRENCY) {
      const batch = nums.slice(i, i + CONCURRENCY);
      const part = await Promise.all(
        batch.map(async (n) => [n, await fetchOnePRImmutable(n)]),
      );
      for (const [n, r] of part) map.set(n, r);
    }
    return map;
  }

  const results = await fetchResults(prNumbers);
  let transientNums = [...results.entries()]
    .filter(([, r]) => r.status === "transient")
    .map(([n]) => n);
  if (transientNums.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
    const second = await fetchResults(transientNums);
    for (const [n, r] of second) results.set(n, r);
    transientNums = [...results.entries()]
      .filter(([, r]) => r.status === "transient")
      .map(([n]) => n);
  }

  const rows = [];
  let okCount = 0;
  for (const n of prNumbers) {
    const r = results.get(n);
    if (r?.status === "ok") {
      okCount += 1;
      rows.push(r.row);
    }
  }
  const cacheable =
    transientNums.length === 0 && (prNumbers.length === 0 || okCount > 0);
  return { rows, cacheable };
}

// --- Release tag commits (cherry-pick map) ----------------------------------

async function fetchPRsOnRelease(tag) {
  const out = new Map();
  const prRe = /#(\d+)/g;
  const maxPages = 10;
  const perPage = 100;
  for (let page = 1; page <= maxPages; page++) {
    const res = await githubFetch(
      `/repos/${REPO}/commits?sha=${encodeURIComponent(tag)}&per_page=${perPage}&page=${page}`,
    );
    if (!res.ok) break;
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) break;
    for (const c of list) {
      const msg = c.commit?.message ?? "";
      prRe.lastIndex = 0;
      let m;
      while ((m = prRe.exec(msg)) !== null) {
        const num = parseInt(m[1], 10);
        if (!out.has(num)) out.set(num, { sha: c.sha, html_url: c.html_url });
      }
    }
    if (list.length < perPage) break;
  }
  return out;
}

// --- Diff → area labels -----------------------------------------------------

function extractPathsFromPatch(patch) {
  const paths = new Set();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m;
  while ((m = re.exec(patch)) !== null) {
    const a = m[1].trimEnd();
    const b = m[2].trimEnd();
    if (a && a !== "/dev/null") paths.add(a);
    if (b && b !== "/dev/null") paths.add(b);
  }
  return paths;
}

function pathToArea(p) {
  const n = p.replace(/\\/g, "/");
  if (n.startsWith("docs/")) return "docs";
  if (n.startsWith("wrappers/")) return "wrappers";
  if (n.startsWith("handsontable/")) return "library";
  return "devops/other";
}

function analyzePatchForAreas(patch) {
  const paths = extractPathsFromPatch(patch);
  const labels = new Set();
  for (const p of paths) labels.add(pathToArea(p));
  if (labels.size === 0 && patch.trim().length > 0) labels.add("devops/other");
  return AREA_ORDER.filter((a) => labels.has(a));
}

function extractPRNumbersFromCommits(commits) {
  const seen = new Set();
  const prRe = /#(\d+)/g;
  for (const c of commits) {
    const msg = c.commit?.message ?? "";
    prRe.lastIndex = 0;
    let m;
    while ((m = prRe.exec(msg)) !== null) {
      seen.add(parseInt(m[1], 10));
    }
  }
  return [...seen].sort((a, b) => a - b);
}

function prItemsFromBulk(rows, cherryPickedMap) {
  const items = rows.map((row) => ({
    number: row.number,
    title: row.title,
    merged_at: row.merged_at,
    html_url: row.html_url,
    author: row.author,
    changelog: row.changelog,
    cherryPickedCommit: cherryPickedMap.get(row.number) ?? null,
    areaLabels: row.diff ? analyzePatchForAreas(row.diff) : [],
  }));
  items.sort((a, b) => (b.merged_at ?? "").localeCompare(a.merged_at ?? ""));
  return items;
}

// --- HTML rendering (parity with edge function) -----------------------------

function renderError(title, message, status) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font: 1rem/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; background: #0f1116; color: #e6edf3; min-height: 100vh; }
    .box { max-width: 32rem; margin: 0 auto; padding: 1.5rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    h1 { margin: 0 0 0.5rem; font-size: 1.25rem; color: #f85149; }
    p { margin: 0; color: #8b949e; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
  return { status, headers: htmlErrorHeaders, body: html };
}

function renderChangelogCell(cl) {
  if (!cl) {
    return '<td class="changelog"><span class="badge badge-none">—</span></td>';
  }
  const typeClass =
    cl.type === "fixed"
      ? "badge-fixed"
      : cl.type === "added"
        ? "badge-added"
        : cl.type === "changed"
          ? "badge-changed"
          : "badge-other";
  const parts = [
    `<span class="badge ${typeClass}">${escapeHtml(cl.type)}</span>`,
    cl.breaking ? '<span class="badge badge-breaking">breaking</span>' : "",
    cl.framework && cl.framework !== "none"
      ? `<span class="badge badge-fw">${escapeHtml(cl.framework)}</span>`
      : "",
    `<span class="changelog-title" title="${escapeHtml(cl.title)}">${escapeHtml(cl.title)}</span>`,
  ].filter(Boolean);
  return `<td class="changelog"><div class="changelog-details">${parts.join(" ")}</div></td>`;
}

function renderCherryPickCell(cherryPickedCommit) {
  if (!cherryPickedCommit) {
    return '<td class="cherry"><span class="badge badge-none">—</span></td>';
  }
  const shortSha = cherryPickedCommit.sha.slice(0, 7);
  return `<td class="cherry"><a href="${escapeHtml(cherryPickedCommit.html_url)}" target="_blank" rel="noopener" class="cherry-link" title="Commit on release">${escapeHtml(shortSha)}</a></td>`;
}

function renderAreaCell(labels) {
  if (labels.length === 0) {
    return '<td class="areas"><span class="badge badge-none">—</span></td>';
  }
  const cls = {
    library: "badge-area-lib",
    wrappers: "badge-area-wrap",
    docs: "badge-area-docs",
    "devops/other": "badge-area-devops",
  };
  const inner = labels
    .map((l) => `<span class="badge ${cls[l]}">${escapeHtml(l)}</span>`)
    .join(" ");
  return `<td class="areas"><div class="area-badges">${inner}</div></td>`;
}

function renderPRRow(pr, formatDate, opts) {
  const inRelease = opts.showInReleaseColumn
    ? renderCherryPickCell(pr.cherryPickedCommit)
    : "";
  return `
    <tr>
      <td class="num"><a href="${escapeHtml(pr.html_url)}" target="_blank" rel="noopener">#${pr.number}</a></td>
      <td class="title">${escapeHtml(pr.title)}</td>
      <td class="author">${pr.author ? escapeHtml(pr.author) : "—"}</td>
      <td class="date">${formatDate(pr.merged_at)}</td>
      ${inRelease}
      ${renderAreaCell(pr.areaLabels)}
      ${renderChangelogCell(pr.changelog)}
    </tr>`;
}

function renderTableBlock(title, prs, formatDate, opts) {
  if (prs.length === 0) return "";
  const headInRelease = opts.showInReleaseColumn ? "<th>In release</th>" : "";
  const rows = prs.map((pr) => renderPRRow(pr, formatDate, opts)).join("");
  return `
    <h2 class="section-title">${escapeHtml(title)}</h2>
    <p class="count">${prs.length} pull request${prs.length !== 1 ? "s" : ""}</p>
    <table>
      <thead>
        <tr>
          <th>PR</th>
          <th>Title</th>
          <th>Author</th>
          <th>Merged</th>
          ${headInRelease}
          <th>Area</th>
          <th>Changelog</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`;
}

function renderPage(release, prsNotInRelease, prsInRelease, compareStats) {
  const formatDate = (iso) =>
    iso
      ? new Date(iso).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";
  const tableMain = renderTableBlock(
    "Not yet on release",
    prsNotInRelease,
    formatDate,
    { showInReleaseColumn: false },
  );
  const tableRelease = renderTableBlock(
    "Also on release (commit on tag)",
    prsInRelease,
    formatDate,
    { showInReleaseColumn: true },
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Changelog PRs · ${escapeHtml(release.tag_name)} → develop</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font: 1rem/1.5 "Segoe UI", system-ui, sans-serif;
      margin: 0;
      padding: 2rem;
      background: #0f1116;
      color: #e6edf3;
      min-height: 100vh;
    }
    .wrap { max-width: 72rem; margin: 0 auto; }
    .section-title {
      margin: 1.25rem 0 0.5rem;
      font-size: 1.125rem;
      font-weight: 600;
      color: #e6edf3;
      letter-spacing: -0.01em;
    }
    h2.section-title ~ h2.section-title { margin-top: 2.5rem; }
    h1 {
      margin: 0 0 0.25rem;
      font-size: 1.75rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .sub {
      margin: 0 0 2rem;
      color: #8b949e;
      font-size: 0.9375rem;
    }
    .sub a { color: #58a6ff; text-decoration: none; }
    .sub a:hover { text-decoration: underline; }
    .release {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      padding: 0.75rem 1rem;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
    }
    .release .tag { font-weight: 600; color: #7ee787; }
    .release .date { color: #8b949e; font-size: 0.875rem; }
    .count { margin-bottom: 0.75rem; color: #8b949e; font-size: 0.875rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      overflow: hidden;
    }
    th {
      text-align: left;
      padding: 0.75rem 1rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #8b949e;
      background: #21262d;
      border-bottom: 1px solid #30363d;
    }
    td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid #21262d;
    }
    tr:last-child td { border-bottom: 0; }
    td.num { width: 5rem; }
    td.num a { color: #58a6ff; text-decoration: none; font-variant-numeric: tabular-nums; }
    td.num a:hover { text-decoration: underline; }
    td.title { color: #e6edf3; }
    td.author { color: #8b949e; font-size: 0.9375rem; }
    td.date { color: #8b949e; font-size: 0.875rem; white-space: nowrap; }
    td.cherry { width: 5rem; }
    td.cherry .cherry-link { color: #7ee787; text-decoration: none; font-family: ui-monospace, monospace; font-size: 0.8125rem; }
    td.cherry .cherry-link:hover { text-decoration: underline; }
    td.changelog { max-width: 20rem; }
    .changelog-details { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.5rem; font-size: 0.875rem; }
    .changelog-title { color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .badge { display: inline-block; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.6875rem; font-weight: 600; text-transform: lowercase; }
    .badge-none { color: #8b949e; background: #21262d; }
    .badge-added { color: #7ee787; background: rgba(126, 231, 135, 0.15); }
    .badge-fixed { color: #f85149; background: rgba(248, 81, 73, 0.15); }
    .badge-changed { color: #79c0ff; background: rgba(121, 192, 255, 0.15); }
    .badge-other { color: #d2a8ff; background: rgba(210, 168, 255, 0.15); }
    .badge-breaking { color: #ff7b72; background: rgba(255, 123, 114, 0.2); }
    .badge-fw { color: #8b949e; background: #21262d; }
    td.areas { max-width: 14rem; }
    .area-badges { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
    .badge-area-lib { color: #ffa657; background: rgba(255, 166, 87, 0.15); text-transform: none; }
    .badge-area-wrap { color: #a5d6ff; background: rgba(165, 214, 255, 0.12); text-transform: none; }
    .badge-area-docs { color: #7ee787; background: rgba(126, 231, 135, 0.12); text-transform: none; }
    .badge-area-devops { color: #8b949e; background: #21262d; text-transform: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Merged PRs since last release</h1>
    <p class="sub">
      <a href="https://github.com/${REPO}">${REPO}</a> · develop branch
    </p>
    <div class="release">
      <span class="tag">${escapeHtml(release.tag_name)}</span>
      <span class="date">${escapeHtml(formatDate(release.published_at))}</span>
    </div>
    <p class="sub">
      <a href="https://github.com/${REPO}/compare/${encodeURIComponent(release.tag_name)}...develop">Compare ${escapeHtml(release.tag_name)}...develop</a>
      ${compareStats ? ` · ${compareStats.totalCommits} commit${compareStats.totalCommits !== 1 ? "s" : ""}` : ""}
      ${compareStats && compareStats.commitsReturned < compareStats.totalCommits ? ` (showing ${compareStats.commitsReturned})` : ""}
    </p>
    <p class="count">${prsNotInRelease.length + prsInRelease.length} pull request${prsNotInRelease.length + prsInRelease.length !== 1 ? "s" : ""} from commits</p>
    ${tableMain}
    ${tableRelease}
  </div>
</body>
</html>`;
}

// --- Bulk cache helpers -----------------------------------------------------

async function readBulkCache(cache, tag, sig) {
  const key = BULK_KEY(tag, sig);
  const data = await getJson(cache, key);
  if (!data || data.v !== 1 || !Array.isArray(data.prs)) return null;
  return data;
}

function storeBulkCacheAsync(cache, tag, sig, payload) {
  const body = safeStringify(payload);
  if (body == null) return;
  if (body.length > BULK_MAX_BYTES) {
    console.warn("[changelog-prs] skip bulk cache (payload too large)");
    return;
  }
  setImmediate(() => {
    cache.set(BULK_KEY(tag, sig), body, BULK_CACHE_TTL_SEC).catch((err) => {
      console.error(
        "[changelog-prs] bulk cache put failed",
        err?.message || err,
      );
    });
  });
}

// --- Express handler --------------------------------------------------------

/**
 * Register the `/api/changelog-prs` route on the given Express app. The cache
 * argument is the CompositeCacheStore returned by `createCacheStore()`.
 */
export function registerChangelogPRsRoute(app, { cache, routePath = "/api/changelog-prs" } = {}) {
  if (!cache) {
    throw new Error(
      "registerChangelogPRsRoute: a cache store is required (see ./cache.js)",
    );
  }

  app.options(routePath, (_req, res) => {
    res.set(corsPreflightHeaders);
    res.status(204).end();
  });

  app.all(routePath, async (req, res) => {
    if (req.method === "OPTIONS") {
      res.set(corsPreflightHeaders);
      return res.status(204).end();
    }
    if (req.method !== "GET") {
      const r = renderError(
        "Method not allowed",
        "Use GET to request this page.",
        405,
      );
      res.set(r.headers);
      return res.status(r.status).send(r.body);
    }

    try {
      const [releaseResult, developHead] = await Promise.all([
        loadLatestReleaseCached(cache),
        getDevelopHeadSha(),
      ]);
      if (!releaseResult.ok) {
        const r = renderError(
          "Failed to fetch latest release",
          releaseResult.body || "Unknown error",
          releaseResult.status,
        );
        res.set(r.headers);
        return res.status(r.status).send(r.body);
      }
      const release = releaseResult.release;
      const tag = release.tag_name;
      if (!tag) {
        const r = renderError(
          "Invalid release data",
          "Missing tag_name for latest release.",
          502,
        );
        res.set(r.headers);
        return res.status(r.status).send(r.body);
      }

      const [cmp, cherryPicked] = await Promise.all([
        fetchCompareCommitsCached(tag, developHead, cache),
        fetchPRsOnReleaseCached(tag, cache),
      ]);
      if (!cmp.ok) {
        const r = renderError(
          "Failed to fetch compare",
          `HTTP ${cmp.status}`,
          cmp.status,
        );
        res.set(r.headers);
        return res.status(r.status).send(r.body);
      }

      const cherryPickedMap = cherryPicked.map;
      const tipSha = cherryPicked.tipSha;
      const commits = cmp.commits;
      const totalCommits = cmp.totalCommits;
      const prNumbers = extractPRNumbersFromCommits(commits);
      const sig = signatureForPRList(prNumbers);

      // Final-HTML shortcut: if absolutely nothing has moved (same tag, same
      // develop HEAD, same tag tip, same PR signature) we can serve a cached
      // HTML blob without even touching the bulk cache. TTL is short so we
      // still pick up e.g. new changelog JSON files within ~2 min.
      const pageKey = PAGE_KEY(tag, developHead, tipSha, sig);
      const cachedPage = await cache.get(pageKey).catch(() => null);
      if (cachedPage) {
        res.set(htmlHeaders);
        return res.status(200).send(cachedPage);
      }

      const cachedBulk =
        prNumbers.length > 0 ? await readBulkCache(cache, tag, sig) : null;

      let prs;
      if (cachedBulk) {
        prs = prItemsFromBulk(cachedBulk.prs, cherryPickedMap);
      } else {
        const { rows, cacheable } = await buildBulkPayload(prNumbers);
        if (prNumbers.length > 0 && cacheable) {
          storeBulkCacheAsync(cache, tag, sig, { v: 1, prs: rows });
        } else if (prNumbers.length > 0 && !cacheable) {
          console.warn(
            "[changelog-prs] skipping bulk cache (transient GitHub errors after retry)",
          );
        }
        prs = prItemsFromBulk(rows, cherryPickedMap);
      }

      const prsNotInRelease = prs.filter((p) => !p.cherryPickedCommit);
      const prsInRelease = prs.filter((p) => p.cherryPickedCommit);

      const html = renderPage(release, prsNotInRelease, prsInRelease, {
        totalCommits,
        commitsReturned: commits.length,
      });

      res.set(htmlHeaders);
      res.status(200).send(html);

      // Persist the assembled page after flushing the response so repeat hits
      // don't block on GitHub at all. TTL intentionally short.
      putJsonAsync_raw(cache, pageKey, html, PAGE_HTML_TTL_SEC);
    } catch (e) {
      console.error("[changelog-prs] handler error:", e);
      const r = renderError("Internal error", String(e), 500);
      if (!res.headersSent) {
        res.set(r.headers);
        res.status(r.status).send(r.body);
      }
    }
  });
}

// Store a raw string (not JSON-wrapped) — used for the final-HTML page cache.
function putJsonAsync_raw(cache, key, value, ttlSec) {
  setImmediate(() => {
    cache.set(key, value, ttlSec).catch((err) => {
      console.error("[changelog-prs] page cache put failed", err?.message || err);
    });
  });
}
