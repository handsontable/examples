// Orchestration + sharing Worker for the Handsontable demo runner.
//
// Tier-2 live editing: per-session Cloudflare Sandbox container running the real
// framework dev server with HMR. proxyToSandbox() transparently proxies the
// preview URL (HTTP + WebSocket/HMR) back through this Worker.
//
// Sharing endpoints (POST/GET/PATCH/DELETE /api/demos) land in Deliverable 5.

import { getSandbox, proxyToSandbox, Sandbox as SandboxBase } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import { FRAMEWORK_DEV, BUILD_CONFIG } from "./frameworks.generated.js";
import { dependencyMetadataFingerprint } from "./dependency-metadata.js";
import { authenticate } from "./auth.js";
import { createDemo, getDemo, getDemoSource, invalidateDemo, serveDemoAsset, updateDemo, type DemoRow } from "./share.js";

// proxyToSandbox() hard-requires a single DO namespace literally named `Sandbox`,
// so live-preview sessions all use ONE class backed by one generic image that
// resolves each demo's deps at session start (per-framework images can't be
// previewed by the SDK). The builder (no preview) keeps its own class.
// Idle window before a live-preview container scales to zero. While a demo tab
// is open the client keepalive + HMR WebSocket keep resetting this timer, so the
// dev server stays warm during active use and only sleeps (stops billing) once
// the user is truly gone. Disk is ephemeral, so a slept container cold-boots on
// return — the point is to avoid that mid-session, not to make wake cheap.
export class Sandbox extends SandboxBase {
  sleepAfter = "15m";
}
export class BuilderSandbox extends SandboxBase {}

const CONTAINER_ROOT = "/app";
const BOOT_LOG = "/tmp/boot.log";
/** Single-quote a trusted command fragment for embedding in `sh -lc`. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
class InvalidFilePathError extends Error {}

/**
 * Resolve a nonempty relative POSIX path under CONTAINER_ROOT.
 */
function resolveContainerPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0) throw new InvalidFilePathError("file path is required");
  const segments = path.split("/");
  if (
    path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment === "node_modules")
  ) {
    throw new InvalidFilePathError(`invalid file path: ${path}`);
  }
  return `${CONTAINER_ROOT}/${segments.join("/")}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate the full file map before creating any directories or files. */
function validateFiles(files: unknown): Record<string, string> {
  if (!isPlainRecord(files)) throw new InvalidFilePathError("files must be a plain record");
  for (const [path, contents] of Object.entries(files)) {
    resolveContainerPath(path);
    if (typeof contents !== "string") throw new InvalidFilePathError(`contents must be a string: ${path}`);
  }
  return files as Record<string, string>;
}

function validateFileWrite(body: unknown): { path: string; contents: string } {
  if (!isPlainRecord(body)) throw new InvalidFilePathError("file write must be a plain record");
  const { path, contents } = body;
  const full = resolveContainerPath(path);
  if (typeof contents !== "string") throw new InvalidFilePathError("contents must be a string");
  return { path: full, contents };
}

// Minimal structural view of the Sandbox stub — avoids deep instantiation of the
// full RPC proxy type (TS2589) while typing exactly the methods we call.
type SandboxLike = {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
  exec(cmd: string): Promise<{ success?: boolean; stdout?: string; stderr?: string }>;
  startProcess(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<unknown>;
  exposePort(port: number, opts?: { hostname?: string }): Promise<{ url?: string; exposedAt?: string }>;
  destroy(): Promise<unknown>;
};
// Cast the function itself so TS never instantiates its deep generic return.
const getSandboxShallow = getSandbox as unknown as (ns: unknown, id: string) => SandboxLike;
/** The single live-preview sandbox namespace (required by proxyToSandbox). */
const liveSbx = (env: Env, id: string): SandboxLike => getSandboxShallow(env.Sandbox, id);
/** Sanitize a session id to the chars proxyToSandbox allows in a preview host. */
const sessionIdFor = (framework: string) =>
  `${framework.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;

function cors(resp: Response): Response {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(resp.body, { status: resp.status, headers: h });
}

const json = (data: unknown, status = 200) =>
  cors(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));

const nowIso = () => new Date().toISOString();

const ROOT_HTML = `<!doctype html><meta charset="utf-8"><title>Handsontable Demos API</title>
<style>body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:12vh auto;padding:0 20px;color:#1f2933}
a{color:#1a8f5a}code{background:#f4f6f8;padding:1px 5px;border-radius:4px}h1{font-size:20px}</style>
<h1>Handsontable Demos — API &amp; orchestration</h1>
<p>This Worker serves shared demos and Tier-2 live sessions. It has no page at the root.</p>
<ul>
<li><code>GET /d/:id</code> — a shared demo (prebuilt, static)</li>
<li><code>GET /embed/:id</code> — docs-only embeddable demo</li>
<li><code>GET /api/health</code> — health check</li>
</ul>
<p>Create and share demos in the authoring app (internal, Handsontable login).</p>`;

/** Public demo JSON with a stale-while-revalidate cache header. */
function cacheableJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

/** Strip internal columns from a demo row before returning it publicly. */
function publicView(row: DemoRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    framework: row.framework,
    tier: row.tier,
    ht_version: row.ht_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Write a validated FilesMap into CONTAINER_ROOT, creating directories. */
async function writeFiles(sandbox: SandboxLike, files: Record<string, string>) {
  const dirs = new Set<string>();
  const resolvedFiles = Object.entries(files).map(([path, contents]) => ({
    full: resolveContainerPath(path),
    contents,
  }));
  for (const { full } of resolvedFiles) {
    const dir = full.slice(0, full.lastIndexOf("/"));
    if (dir && dir !== CONTAINER_ROOT) dirs.add(dir);
  }
  for (const dir of dirs) {
    try {
      await sandbox.mkdir(dir, { recursive: true });
    } catch {
      /* dir may exist */
    }
  }
  for (const { full, contents } of resolvedFiles) {
    await sandbox.writeFile(full, contents);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 1) Preview-URL traffic (and its HMR WebSocket) is proxied to the container.
    // Cast to keep TS from instantiating the SDK's deep generic over Env (TS2589).
    const proxy = proxyToSandbox as unknown as (r: Request, e: Env) => Promise<Response | null>;
    const proxied = await proxy(request, env);
    if (proxied) return proxied;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","session",...]

    try {
      // POST /api/session  { framework, files, sessionId? } -> { sessionId, previewUrl }
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts.length === 2) {
        const body = await request.json() as {
          framework: string;
          files: unknown;
          sessionId?: string;
          htVersion?: string;
        };
        if (!isPlainRecord(body)) return json({ error: "request body must be a plain record" }, 400);
        const dev = FRAMEWORK_DEV[body.framework];
        const cfg = BUILD_CONFIG[body.framework];
        if (!dev || !cfg) return json({ error: `Tier-2 not wired for framework: ${body.framework}` }, 400);
        const files = validateFiles(body.files);

        const sessionId = body.sessionId?.trim() || sessionIdFor(body.framework);
        const sandbox = liveSbx(env, sessionId);

        await writeFiles(sandbox, files);
        // Boot asynchronously (returns immediately; UI polls /status for live
        // progress). Default boot seeds immutable baked dependencies, then runs
        // fast frozen pnpm reconciliation. Keep submitted starters frozen; only
        // custom package or lock metadata may update the lockfile.
        const dependencyFingerprint = await dependencyMetadataFingerprint({
          packageJson: files["package.json"],
          pnpmLock: files["pnpm-lock.yaml"],
        });
        const metadataDiffersFromStarter = dependencyFingerprint !== dev.sourceDependencyFingerprint;
        const installDependencies = files["pnpm-lock.yaml"] !== undefined
          ? [
              `if ! pnpm install --frozen-lockfile; then`,
              metadataDiffersFromStarter
                ? `  echo '::frozen install failed for custom metadata; retrying non-frozen::'; pnpm install --no-frozen-lockfile`
                : `  echo '::error::frozen install failed for generated starter metadata; refusing to modify its lockfile' >&2; exit 1`,
              `fi`,
            ]
          : metadataDiffersFromStarter
            ? [`echo '::no lockfile for custom metadata; installing non-frozen::'; pnpm install --no-frozen-lockfile`]
            : [`echo '::error::generated starter is missing its lockfile; refusing non-frozen install' >&2; exit 1`];
        const script = [
          `set -e`,
          `cd ${CONTAINER_ROOT}`,
          `echo '::seeding immutable baked dependencies::'`,
          `rm -rf ./node_modules`,
          `cp -al /baked/${dev.bakedKey}/node_modules ./node_modules`,
          `echo '::reconciling dependencies with pnpm::'`,
          ...installDependencies,
          `echo '::starting dev server::'`,
          dev.cmd,
        ].join("\n");
        await sandbox.startProcess(`sh -lc ${shq(`{ ${script} ; } > ${BOOT_LOG} 2>&1`)}`);

        // Preview URL host: the wildcard domain in production (PREVIEW_HOST), or
        // the request host in local dev (localhost:8787 -> *.localhost:8787).
        const previewHost = env.PREVIEW_HOST && env.PREVIEW_HOST.length ? env.PREVIEW_HOST : url.host;
        const exposed = await sandbox.exposePort(dev.port, { hostname: previewHost });
        const previewUrl = (exposed as { url?: string; exposedAt?: string }).url
          ?? (exposed as { exposedAt?: string }).exposedAt;
        return json({ sessionId, previewUrl, port: dev.port });
      }

      // POST /api/session/:id/file  { path, contents } -> 204   (streams an edit; HMR picks it up)
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts[3] === "file") {
        const sessionId = parts[2]!;
        const body = validateFileWrite(await request.json());
        const sandbox = liveSbx(env, sessionId);
        const full = body.path;
        const dir = full.slice(0, full.lastIndexOf("/"));
        if (dir && dir !== CONTAINER_ROOT) {
          try { await sandbox.mkdir(dir, { recursive: true }); } catch { /* exists */ }
        }
        await sandbox.writeFile(full, body.contents);
        return cors(new Response(null, { status: 204 }));
      }

      // DELETE /api/session/:id/file?path= -> remove a file (file-tree delete/rename)
      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "session" && parts[3] === "file") {
        const sandbox = liveSbx(env, parts[2]!);
        const p = url.searchParams.get("path") ?? "";
        const full = resolveContainerPath(p);
        try { await sandbox.deleteFile(full); } catch { /* best effort */ }
        return cors(new Response(null, { status: 204 }));
      }

      // GET /api/session/:id/status?port=NNNN -> { ready, log } (boot progress)
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts[3] === "status") {
        const sandbox = liveSbx(env, parts[2]!);
        const port = Number(url.searchParams.get("port")) || 0;
        let ready = false;
        if (port) {
          const probe = `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`;
          try { ready = (await sandbox.exec(probe)).success === true; } catch { ready = false; }
        }
        let log = "";
        try {
          const r = await sandbox.exec(`sh -lc "tail -c 2500 ${BOOT_LOG} 2>/dev/null || true"`);
          log = r.stdout ?? "";
        } catch { /* no log yet */ }
        return json({ ready, log });
      }

      // DELETE /api/session/:id -> destroy container
      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "session" && parts.length === 3) {
        const sandbox = liveSbx(env, parts[2]!);
        await sandbox.destroy();
        return cors(new Response(null, { status: 204 }));
      }

      // ---- Sharing (D5) ----------------------------------------------------

      // POST /api/demos  (auth) — fork -> build -> R2 -> short id -> /d/:id
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "demos" && parts.length === 2) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const body = (await request.json()) as {
          framework: string;
          files: Record<string, string>;
          title?: string;
          description?: string;
          htVersion?: string;
          forkedFrom?: string;
        };
        const cfg = BUILD_CONFIG[body.framework];
        if (!cfg) return json({ error: `unknown framework: ${body.framework}` }, 400);
        if (!body.title?.trim()) return json({ error: "title is required" }, 400);
        if (!body.files || !body.files["/package.json"]) return json({ error: "files must include /package.json" }, 400);

        const created = await createDemo(env, {
          entry: { framework: body.framework, ...cfg },
          files: body.files,
          htVersion: body.htVersion ?? "latest",
          title: body.title.trim(),
          description: body.description ?? null,
          createdBy: id.email,
          forkedFrom: body.forkedFrom ?? `catalog:${body.framework}`,
          now: nowIso(),
        });
        return json({ id: created.id, url: `/d/${created.id}`, embedUrl: `/embed/${created.id}` }, 201);
      }

      // GET /api/demos  (auth, ?mine=1) — list the caller's demos
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "demos" && parts.length === 2) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const rows = await env.DB.prepare(
          "SELECT id,title,description,framework,tier,ht_version,forked_from,visibility,revoked,created_at,updated_at FROM demos WHERE created_by = ? ORDER BY updated_at DESC",
        ).bind(id.email).all();
        return json({ demos: rows.results });
      }

      // GET /api/demos/:id/source  (public) — source snapshot for the read-only
      // share playground and for forking. A demo link is unlisted-but-public, so
      // its code is viewable by anyone with the link (revoked demos return 404).
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "demos" && parts[3] === "source") {
        const src = await getDemoSource(env, parts[2]!);
        if (!src) return json({ error: "not found" }, 404);
        return json(src);
      }

      // GET /api/demos/:id  (public) — metadata; 410 if revoked
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "demos" && parts.length === 3) {
        const row = await getDemo(env, parts[2]!);
        if (!row) return json({ error: "not found" }, 404);
        if (row.revoked) return json({ error: "revoked" }, 410);
        return cors(cacheableJson(publicView(row)));
      }

      // PATCH /api/demos/:id  (auth, owner) — update title/description/visibility
      if (request.method === "PATCH" && parts[0] === "api" && parts[1] === "demos" && parts.length === 3) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const demoId = parts[2]!;
        const row = await getDemo(env, demoId);
        if (!row) return json({ error: "not found" }, 404);
        if (row.created_by !== id.email) return json({ error: "forbidden" }, 403);
        const patch = (await request.json()) as {
          title?: string; description?: string; visibility?: string;
          files?: Record<string, string>; htVersion?: string;
        };
        // Code change -> rebuild the snapshot in place (edit-page Save).
        if (patch.files) {
          if (!patch.files["/package.json"]) return json({ error: "files must include /package.json" }, 400);
          const cfg = BUILD_CONFIG[row.framework];
          if (!cfg) return json({ error: `unknown framework: ${row.framework}` }, 400);
          await updateDemo(env, {
            id: demoId,
            entry: { framework: row.framework, ...cfg },
            files: patch.files,
            htVersion: patch.htVersion ?? row.ht_version,
            title: patch.title?.trim() || row.title,
            description: patch.description ?? row.description,
            now: nowIso(),
          });
          return json({ ok: true });
        }
        // Metadata-only update (title / description / visibility).
        await env.DB.prepare("UPDATE demos SET title=?, description=?, visibility=?, updated_at=? WHERE id=?")
          .bind(patch.title ?? row.title, patch.description ?? row.description, patch.visibility ?? row.visibility, nowIso(), demoId)
          .run();
        await invalidateDemo(env, demoId);
        return json({ ok: true });
      }

      // DELETE /api/demos/:id  (auth, owner) — revoke (410 thereafter)
      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "demos" && parts.length === 3) {
        const id = await authenticate(request, env);
        if (!id) return json({ error: "unauthorized" }, 401);
        const demoId = parts[2]!;
        const row = await getDemo(env, demoId);
        if (!row) return json({ error: "not found" }, 404);
        if (row.created_by !== id.email) return json({ error: "forbidden" }, 403);
        await env.DB.prepare("UPDATE demos SET revoked=1, revoked_at=?, updated_at=? WHERE id=?")
          .bind(nowIso(), nowIso(), demoId).run();
        await invalidateDemo(env, demoId);
        return cors(new Response(null, { status: 204 }));
      }

      // GET /d/:id[/*]  and  /embed/:id[/*]  — public static viewer / docs embed
      if (request.method === "GET" && (parts[0] === "d" || parts[0] === "embed") && parts.length >= 2) {
        const embed = parts[0] === "embed";
        const demoId = parts[1]!;
        const sub = parts.slice(2).join("/");
        // Redirect /d/:id -> /d/:id/ so relative asset paths (./assets/...) resolve
        // under the demo prefix rather than the site root.
        if (sub === "" && !url.pathname.endsWith("/")) {
          return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 308);
        }
        return await serveDemoAsset(env, demoId, sub, { embed });
      }

      // GET /api/versions (public) — real published Handsontable versions.
      if (request.method === "GET" && parts[0] === "api" && parts[1] === "versions") {
        const cached = await env.CACHE.get("versions", "json");
        if (cached) return cors(cacheableJson(cached));
        try {
          const r = await fetch("https://registry.npmjs.org/handsontable");
          const j = (await r.json()) as {
            "dist-tags"?: Record<string, string>;
            versions?: Record<string, unknown>;
          };
          const latest = j["dist-tags"]?.latest ?? null;
          const next = j["dist-tags"]?.next ?? null;
          const cmp = (a: string, b: string) => {
            const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
            for (let i = 0; i < 3; i++) { const d = (pb[i] ?? 0) - (pa[i] ?? 0); if (d) return d; }
            return 0;
          };
          const versions = Object.keys(j.versions ?? {})
            .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
            .filter((v) => { const m = Number(v.split(".")[0]); return m >= 15 && m <= 19; })
            .sort(cmp)
            .slice(0, 15);
          const payload = { latest, next, versions };
          await env.CACHE.put("versions", JSON.stringify(payload), { expirationTtl: 3600 });
          return cors(cacheableJson(payload));
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }

      if (parts[0] === "api" && parts[1] === "health") return json({ ok: true });

      // Friendly root (this is the API/orchestration worker, not a site).
      if (parts.length === 0) {
        return new Response(ROOT_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return cors(new Response("Not found", { status: 404 }));
    } catch (err) {
      if (err instanceof InvalidFilePathError) return json({ error: err.message }, 400);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
};

