// Sharing (D5) + build snapshotter (D7).
//
// On Share: version-inject files -> run the real framework build in a generic
// builder container -> upload the static output to R2 -> record metadata in D1 ->
// mint a short id. Client views serve immutable static artifacts from R2 (no live
// container). Builds are immutable per (framework, ht_version, files_hash) and
// cached forever (ADR-0006).

import { getSandbox } from "@cloudflare/sandbox";
import { injectSchemeIntoHtml } from "@handsontable/demo-runtime/scheme";
import type { Env } from "./env.js";
import { errorPageResponse, wantsHtmlError } from "./error-page.js";
import { recordContainerUsage, SESSION_INSTANCE_TYPE } from "./budget.js";

type SandboxLike = {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
  readFile(path: string): Promise<string | { content?: string; encoding?: string; isBinary?: boolean }>;
  exec(cmd: string): Promise<{ success?: boolean; stdout?: string; stderr?: string; exitCode?: number }>;
  destroy(): Promise<unknown>;
};
const builder = (env: Env, id: string): SandboxLike =>
  (getSandbox as unknown as (ns: unknown, id: string) => SandboxLike)(env.SANDBOX_BUILDER, id);

const CONTAINER_ROOT = "/app";

export interface DemoRow {
  id: string;
  title: string;
  description: string | null;
  framework: string;
  tier: number;
  ht_version: string;
  files_hash: string;
  r2_prefix: string;
  forked_from: string | null;
  visibility: string;
  revoked: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

/** Minimal catalog entry shape needed for building. */
export interface BuildEntry {
  framework: string;
  tier: number;
  installCommand: string;
  buildCommand: string;
  outputDir: string;
  outputGlob: string | null;
}

/** Bump whenever the build pipeline changes what artifacts contain (runtime
 *  patching, binary handling, ...). Part of every build_cache key, so cached
 *  artifacts produced by an older pipeline are never reused. */
const BUILD_PIPELINE_VERSION = 2;

/** build_cache key for a (framework, version, files) triple. */
export function buildCacheKey(framework: string, htVersion: string, hash: string): string {
  return `v${BUILD_PIPELINE_VERSION}:${framework}:${htVersion}:${hash}`;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function filesHash(files: Record<string, string>): Promise<string> {
  const sorted = Object.keys(files).sort().map((k) => `${k}\u0000${files[k]}`).join("\u0001");
  return (await sha256Hex(sorted)).slice(0, 32);
}

export function shortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(36)).join("").slice(0, 10);
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Tail of a failed exec's output. pnpm (and some build tools) report errors
 *  on stdout, so surface both streams, stdout last. */
function execTail(r: { stdout?: string; stderr?: string }, n: number): string {
  return [r.stderr, r.stdout].filter((s) => s?.trim()).join("\n").slice(-n);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Artifact contents: text for source/markup, raw bytes for binary assets. */
export type ArtifactContents = string | Uint8Array;

/**
 * Turbopack's browser runtime registers each chunk by stripping a compiled
 * "/_next/" prefix from the script's `src` attribute; unmatched srcs keep the
 * prefix and never match the runtime's expected chunk ids. Our demos are
 * served under a path prefix (/d/:id/, /embed/:id/) with root-absolute refs
 * rewritten to relative ("_next/..."), so the prefix never matches, the entry
 * module never executes, and the page stays blank with no console errors.
 * Relax the compiled prefix to the relative form the rewritten HTML serves.
 */
function patchTurbopackRuntime(rel: string, contents: ArtifactContents): ArtifactContents {
  if (typeof contents !== "string" || !rel.endsWith(".js") || !contents.includes("globalThis.TURBOPACK")) {
    return contents;
  }
  return contents.replace(/\blet ([A-Za-z_$][\w$]*)="\/_next\/"/, 'let $1="_next/"');
}

/** Run the framework build in a builder container; return { relPath -> contents }. */
export async function runBuild(
  env: Env,
  entry: BuildEntry,
  files: Record<string, string>,
): Promise<Record<string, ArtifactContents>> {
  const sbx = builder(env, `build--${shortId()}`);
  // A build is a container awake window like any other; the finally below books
  // it against the cost ledger whether the build succeeded or threw.
  const startedAt = Date.now();
  try {
    // Write source into /app.
    const dirs = new Set<string>();
    for (const p of Object.keys(files)) {
      const full = CONTAINER_ROOT + (p.startsWith("/") ? p : `/${p}`);
      const dir = full.slice(0, full.lastIndexOf("/"));
      if (dir && dir !== CONTAINER_ROOT) dirs.add(dir);
    }
    for (const d of dirs) { try { await sbx.mkdir(d, { recursive: true }); } catch { /* exists */ } }
    for (const [p, c] of Object.entries(files)) {
      await sbx.writeFile(CONTAINER_ROOT + (p.startsWith("/") ? p : `/${p}`), c);
    }

    let install = await sbx.exec(`sh -lc "cd ${CONTAINER_ROOT} && ${entry.installCommand}"`);
    if (install.success === false) {
      // Authoring edits (e.g. re-pinning the Handsontable version) change
      // package.json without regenerating the lockfile, so a frozen install
      // can't succeed. The builder is ephemeral and never persists the
      // lockfile, so falling back to a non-frozen install is safe here
      // (mirrors the live-session policy for custom dependency metadata).
      install = await sbx.exec(
        `sh -lc "cd ${CONTAINER_ROOT} && ${entry.installCommand.replace(" --frozen-lockfile", "")} --no-frozen-lockfile"`,
      );
    }
    if (install.success === false) throw new Error(`install failed: ${execTail(install, 800)}`);

    // Snapshots only need the bundle, not type-checking. Strip leading
    // type-check steps (tsc / vue-tsc) that often fail in ephemeral containers
    // and don't affect the built output.
    const buildCommand = entry.buildCommand
      .replace(/^\s*(tsc(\s+-b)?|vue-tsc[^&]*)\s*&&\s*/i, "");
    // Prepend node_modules/.bin so the raw build command resolves local binaries
    // (vite, ng, next, ...) without relying on an npm script.
    const build = await sbx.exec(
      `sh -lc "cd ${CONTAINER_ROOT} && export PATH=${CONTAINER_ROOT}/node_modules/.bin:$PATH && ${buildCommand}"`,
    );
    if (build.success === false) throw new Error(`build failed: ${execTail(build, 1200)}`);

    // Resolve the output directory (angular nests under dist/<project>/browser).
    let outDir = `${CONTAINER_ROOT}/${entry.outputDir}`;
    if (entry.outputGlob) {
      const g = await sbx.exec(`sh -lc "ls -d ${CONTAINER_ROOT}/${entry.outputGlob} 2>/dev/null | head -1"`);
      if (g.stdout?.trim()) outDir = g.stdout.trim();
    }

    const list = await sbx.exec(`sh -lc "cd '${outDir}' && find . -type f"`);
    const rels = (list.stdout ?? "")
      .split("\n").map((s) => s.replace(/^\.\//, "").trim()).filter(Boolean);
    if (!rels.length) throw new Error(`build produced no files in ${outDir}`);

    const out: Record<string, ArtifactContents> = {};
    for (const rel of rels) {
      const f = await sbx.readFile(`${outDir}/${rel}`);
      // The SDK auto-detects binary files and returns their content base64-
      // encoded; storing that string verbatim would serve base64 text (fonts,
      // images) — decode back to raw bytes for R2.
      const contents: ArtifactContents = typeof f === "string"
        ? f
        : f.encoding === "base64" || f.isBinary
          ? base64ToBytes(f.content ?? "")
          : (f.content ?? "");
      out[rel] = patchTurbopackRuntime(rel, contents);
    }
    return out;
  } finally {
    try { await sbx.destroy(); } catch { /* best effort */ }
    try {
      await recordContainerUsage(env, {
        instanceType: SESSION_INSTANCE_TYPE,
        awakeSeconds: (Date.now() - startedAt) / 1000,
      });
    } catch { /* metering must never fail a build */ }
  }
}

export interface CreateArgs {
  entry: BuildEntry;
  files: Record<string, string>;      // already version-injected
  htVersion: string;
  title: string;
  description?: string | null;
  createdBy: string;
  forkedFrom?: string | null;
  now: string;                          // ISO timestamp (Workers-safe: passed in)
  id?: string;                          // fixed id (render-ms compat); else random
  visibility?: string;                  // 'unlisted' (default) | 'public'
}

/** Build (or reuse cached build), store to R2, insert into D1, return the demo id. */
export async function createDemo(env: Env, args: CreateArgs): Promise<{ id: string }> {
  const hash = await filesHash(args.files);
  const buildKey = buildCacheKey(args.entry.framework, args.htVersion, hash);

  // Reuse a prior identical build if present.
  const cached = await env.DB.prepare("SELECT r2_prefix FROM build_cache WHERE build_key = ?")
    .bind(buildKey).first<{ r2_prefix: string }>();

  const id = args.id ?? shortId();
  const r2Prefix = `demos/${id}/`;

  if (cached) {
    // Copy the cached artifact under the new id's prefix (cheap; keeps ids independent).
    const src = cached.r2_prefix;
    const listed = await env.ARTIFACTS.list({ prefix: src });
    for (const obj of listed.objects) {
      const body = await env.ARTIFACTS.get(obj.key);
      if (body) await env.ARTIFACTS.put(r2Prefix + obj.key.slice(src.length), body.body);
    }
  } else {
    const built = await runBuild(env, args.entry, args.files);
    for (const [rel, contents] of Object.entries(built)) {
      await env.ARTIFACTS.put(r2Prefix + rel, contents, {
        httpMetadata: { contentType: contentTypeFor(rel) },
      });
    }
    await env.DB.prepare("INSERT OR REPLACE INTO build_cache (build_key, r2_prefix, created_at) VALUES (?,?,?)")
      .bind(buildKey, r2Prefix, args.now).run();
  }

  // Store the source snapshot (for forking a saved demo). Served only via the
  // authenticated /api/demos/:id/source route, never as a public /d asset.
  await env.ARTIFACTS.put(
    `${r2Prefix}__source.json`,
    JSON.stringify({ framework: args.entry.framework, files: args.files }),
    { httpMetadata: { contentType: "application/json" } },
  );

  await env.DB.prepare(
    `INSERT OR REPLACE INTO demos (id,title,description,framework,tier,ht_version,files_hash,r2_prefix,forked_from,visibility,revoked,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, ?, 0, ?,?,?)`,
  ).bind(
    id, args.title, args.description ?? null, args.entry.framework, args.entry.tier,
    args.htVersion, hash, r2Prefix, args.forkedFrom ?? null, args.visibility ?? "unlisted",
    args.createdBy, args.now, args.now,
  ).run();
  await invalidateDemo(env, id);

  return { id };
}

export interface UpdateArgs {
  id: string;
  entry: BuildEntry;
  files: Record<string, string>;   // already version-injected
  htVersion: string;
  /** Metadata, only when the request actually carried it. Absent means "leave the
   *  stored value alone", and that distinction is load-bearing (DEV-2495): a
   *  rebuild runs a container and takes seconds to minutes, so its caller read the
   *  row long before this writes. Passing that stale row's title back in — which is
   *  what a required field forces — reverts any rename committed in the meantime,
   *  the metadata-writer race one level down from the client. */
  title?: string;
  description?: string | null;
  now: string;
}

/** Rebuild a saved demo in place (edit-page Save): re-run the build for the new
 *  code, overwrite the demo's R2 artifacts + source snapshot, and update its row.
 *  The demo id, prefix, owner, and lineage are preserved. */
export async function updateDemo(env: Env, args: UpdateArgs): Promise<void> {
  const hash = await filesHash(args.files);
  const buildKey = buildCacheKey(args.entry.framework, args.htVersion, hash);
  const r2Prefix = `demos/${args.id}/`;

  const cached = await env.DB.prepare("SELECT r2_prefix FROM build_cache WHERE build_key = ?")
    .bind(buildKey).first<{ r2_prefix: string }>();

  if (cached && cached.r2_prefix !== r2Prefix) {
    const src = cached.r2_prefix;
    const listed = await env.ARTIFACTS.list({ prefix: src });
    for (const obj of listed.objects) {
      const body = await env.ARTIFACTS.get(obj.key);
      if (body) await env.ARTIFACTS.put(r2Prefix + obj.key.slice(src.length), body.body);
    }
  } else if (!cached) {
    const built = await runBuild(env, args.entry, args.files);
    for (const [rel, contents] of Object.entries(built)) {
      await env.ARTIFACTS.put(r2Prefix + rel, contents, {
        httpMetadata: { contentType: contentTypeFor(rel) },
      });
    }
    await env.DB.prepare("INSERT OR REPLACE INTO build_cache (build_key, r2_prefix, created_at) VALUES (?,?,?)")
      .bind(buildKey, r2Prefix, args.now).run();
  }
  // (cached && cached.r2_prefix === r2Prefix): identical code already built here.

  await env.ARTIFACTS.put(
    `${r2Prefix}__source.json`,
    JSON.stringify({ framework: args.entry.framework, files: args.files }),
    { httpMetadata: { contentType: "application/json" } },
  );

  // Built column by column so an absent title or description is *not written*,
  // rather than written back as whatever the row held when the rebuild started.
  const sets = ["ht_version=?", "files_hash=?", "updated_at=?"];
  const binds: unknown[] = [args.htVersion, hash, args.now];
  if (args.title !== undefined) { sets.push("title=?"); binds.push(args.title); }
  if (args.description !== undefined) { sets.push("description=?"); binds.push(args.description ?? null); }
  await env.DB.prepare(`UPDATE demos SET ${sets.join(", ")} WHERE id=?`).bind(...binds, args.id).run();
  await invalidateDemo(env, args.id);
}

export async function getDemo(env: Env, id: string): Promise<DemoRow | null> {
  const cacheKey = `demo:${id}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return cached as DemoRow;
  const row = await env.DB.prepare("SELECT * FROM demos WHERE id = ?").bind(id).first<DemoRow>();
  if (row) await env.CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 300 });
  return row;
}

export async function invalidateDemo(env: Env, id: string): Promise<void> {
  await env.CACHE.delete(`demo:${id}`);
}

/** Source snapshot for forking a saved demo: { framework, files }. */
export async function getDemoSource(
  env: Env,
  id: string,
): Promise<{ framework: string; files: Record<string, string> } | null> {
  const row = await getDemo(env, id);
  if (!row || row.revoked) return null;
  const obj = await env.ARTIFACTS.get(`${row.r2_prefix}__source.json`);
  if (!obj) return null;
  return JSON.parse(await obj.text()) as { framework: string; files: Record<string, string> };
}

/** Serve a built static asset for /d/:id/* (or /embed/:id/*). */
export async function serveDemoAsset(
  env: Env,
  id: string,
  subpath: string,
  opts: { embed: boolean },
): Promise<Response> {
  // T9 (DEV-2163) gave the user-facing 404/410 a branded HTML body. Statuses and triggers are
  // unchanged; only document-ish requests get the page, so a missing hashed asset
  // still answers in plain text (`wantsHtmlError`). Inside `/embed/:id` the page
  // renders in someone else's docs article, so it gets no "back to" link.
  const html = wantsHtmlError(subpath);
  const homeUrl = opts.embed ? undefined : "/";

  const row = await getDemo(env, id);
  if (!row) {
    return html
      ? errorPageResponse({
          status: 404,
          title: "Demo not found",
          body: "This link doesn't point at a demo. It may have been mistyped, or the demo may never have existed.",
          homeUrl,
        })
      : new Response("Not found", { status: 404 });
  }
  if (row.revoked) {
    return html
      ? errorPageResponse({
          status: 410,
          title: "This demo has been revoked",
          body: "Its owner deleted it, so the link no longer resolves. Nothing here is recoverable from this page.",
          homeUrl,
        })
      : new Response("This demo has been revoked.", { status: 410 });
  }

  const clean = subpath.replace(/^\/+/, "");
  // Never serve the private source snapshot as a public asset. Stays plain text:
  // every `__`-prefixed path is a file request, never a document one.
  if (clean.split("/").some((seg) => seg.startsWith("__"))) {
    return new Response("Not found", { status: 404 });
  }
  const candidates = clean === "" ? ["index.html"] : [clean, `${clean}/index.html`, "index.html"];

  let obj: R2ObjectBodyText | null = null;
  let hitPath = "index.html";
  for (const c of candidates) {
    obj = await env.ARTIFACTS.get(row.r2_prefix + c);
    if (obj) { hitPath = c; break; }
  }
  // The row exists but the artifact doesn't — a build that never uploaded, or a
  // path inside the demo that its framework build never emitted.
  if (!obj) {
    return html
      ? errorPageResponse({
          status: 404,
          title: "Page not found",
          body: "This demo exists, but it has nothing to serve at this path.",
          homeUrl,
        })
      : new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  headers.set("Content-Type", contentTypeFor(hitPath));
  // Hashed assets are immutable; the HTML entry is re-served under the same URL
  // after an edit/rebuild, so it must not be cached long (or header changes and
  // saved edits would never reach clients).
  headers.set(
    "Cache-Control",
    hitPath.endsWith(".html") ? "public, max-age=0, must-revalidate" : "public, max-age=31536000, immutable",
  );
  if (opts.embed) {
    headers.set("Content-Security-Policy", `frame-ancestors ${env.EMBED_ALLOWED_ANCESTORS}`);
  } else {
    // Allow our own same-origin /share/:id page to frame the built demo, but no
    // third-party site (the docs embed goes through /embed/:id instead).
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }

  // The demo is served under a path prefix (/d/:id/ or /embed/:id/), but framework
  // builds emit root-absolute asset refs (src="/assets/...", href="/_next/..."),
  // which would escape the prefix and hit the SPA at the site root. Rewrite the
  // HTML entry's root-absolute refs to relative so they resolve under the prefix
  // (the /d/:id -> /d/:id/ redirect guarantees a trailing slash to resolve against).
  if (hitPath.endsWith(".html")) {
    // The colour-scheme receiver rides along with the root-path fix (DEV-2561):
    // `/d/:id` is what full mode frames, and a maximised demo that stopped
    // following the shell would be a visible seam against the pane it came from.
    // Inert wherever nothing posts to it — `/embed/:id` on the documentation site
    // is framed by a page that never sends the message.
    const rewritten = injectSchemeIntoHtml(rewriteHtmlRoots(await obj.text()));
    return new Response(rewritten, { headers });
  }
  return new Response(obj.body, { headers });
}

/** Strip a single leading slash from src/href/url() targets so root-absolute
 *  asset references resolve relative to the demo's path prefix. Leaves
 *  protocol-relative (//) and absolute (http(s)://, data:) URLs untouched.
 *  Also rewrites "/_next/..." refs inside inline scripts (React flight
 *  payload): the client runtime inserts stylesheet/font/chunk links from
 *  those strings verbatim, and root-absolute ones would escape the demo's
 *  path prefix and 404 — which silently blocks hydration commit. */
function rewriteHtmlRoots(html: string): string {
  return html
    .replace(/(\s(?:src|href)\s*=\s*)(["'])\/(?!\/)/gi, "$1$2")
    .replace(/(url\(\s*["']?)\/(?!\/)/gi, "$1")
    .replace(/\\"\/_next\//g, '\\"_next/')
    .replace(/"\/_next\//g, '"_next/');
}

// R2 types (avoid importing the heavy generated types here).
interface R2ObjectBodyText { body: ReadableStream; text(): Promise<string>; }
