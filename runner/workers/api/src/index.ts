// Orchestration + sharing Worker for the Handsontable demo runner.
//
// Tier-2 live editing: per-session Cloudflare Sandbox container running the real
// framework dev server with HMR. proxyToSandbox() transparently proxies the
// preview URL (HTTP + WebSocket/HMR) back through this Worker.
//
// Sharing endpoints (POST/GET/PATCH/DELETE /api/demos) land in Deliverable 5.

import { getSandbox, proxyToSandbox, Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import { FRAMEWORK_DEV } from "./frameworks.generated.js";

// One Durable Object class per framework image (Cloudflare binds one image per
// class). Each is a thin Sandbox subclass; the image is set in wrangler.jsonc.
export class RemixSandbox extends Sandbox {}
export class AngularSandbox extends Sandbox {}
export class NextSandbox extends Sandbox {}
export class NextShadcnSandbox extends Sandbox {}
export class AstroSandbox extends Sandbox {}
export class NuxtSandbox extends Sandbox {}

const CONTAINER_ROOT = "/app";

// container name -> DO binding, derived from the generated dev map.
const CONTAINER_BINDING: Record<string, string> = Object.fromEntries(
  Object.values(FRAMEWORK_DEV).map((d) => [d.container, d.binding]),
);

// Minimal structural view of the Sandbox stub — avoids deep instantiation of the
// full RPC proxy type (TS2589) while typing exactly the methods we call.
type SandboxLike = {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
  exec(cmd: string): Promise<{ success?: boolean; stdout?: string; stderr?: string }>;
  startProcess(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<unknown>;
  exposePort(port: number, opts?: { hostname?: string }): Promise<{ url?: string; exposedAt?: string }>;
  destroy(): Promise<unknown>;
};
// Cast the function itself so TS never instantiates its deep generic return.
const getSandboxShallow = getSandbox as unknown as (ns: unknown, id: string) => SandboxLike;
/** Resolve the sandbox for a given DO binding name. */
const sbxByBinding = (env: Env, binding: string, id: string): SandboxLike =>
  getSandboxShallow(env[binding], id);
/** container prefix of a sessionId (`<container>--<uuid>`). */
const containerOf = (sessionId: string) => sessionId.split("--")[0]!;

function cors(resp: Response): Response {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(resp.body, { status: resp.status, headers: h });
}

const json = (data: unknown, status = 200) =>
  cors(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }));

/** Write a FilesMap ("/path" -> contents) into CONTAINER_ROOT, creating dirs. */
async function writeFiles(sandbox: SandboxLike, files: Record<string, string>) {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const full = CONTAINER_ROOT + (p.startsWith("/") ? p : `/${p}`);
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
  for (const [p, contents] of Object.entries(files)) {
    const full = CONTAINER_ROOT + (p.startsWith("/") ? p : `/${p}`);
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
        const body = (await request.json()) as {
          framework: string;
          files: Record<string, string>;
          sessionId?: string;
        };
        const dev = FRAMEWORK_DEV[body.framework];
        if (!dev) return json({ error: `Tier-2 not wired for framework: ${body.framework}` }, 400);

        // sessionId encodes the container so file/delete routes pick the right image.
        const sessionId = `${dev.container}--${crypto.randomUUID().slice(0, 8)}`;
        const sandbox = sbxByBinding(env, dev.binding, sessionId);

        await writeFiles(sandbox, body.files);
        // Start the real dev server (a fresh session id = a fresh container).
        await sandbox.startProcess(dev.cmd, { cwd: CONTAINER_ROOT });
        await waitForPort(sandbox, dev.port);

        // Use host (incl. port) so preview URLs route back to this Worker in
        // local dev (localhost:8787) and to the wildcard domain in production.
        const exposed = await sandbox.exposePort(dev.port, { hostname: url.host });
        const previewUrl = (exposed as { url?: string; exposedAt?: string }).url
          ?? (exposed as { exposedAt?: string }).exposedAt;
        return json({ sessionId, previewUrl, port: dev.port });
      }

      // POST /api/session/:id/file  { path, contents } -> 204   (streams an edit; HMR picks it up)
      if (request.method === "POST" && parts[0] === "api" && parts[1] === "session" && parts[3] === "file") {
        const sessionId = parts[2]!;
        const body = (await request.json()) as { path: string; contents: string };
        const binding = CONTAINER_BINDING[containerOf(sessionId)];
        if (!binding) return json({ error: `unknown session container: ${sessionId}` }, 400);
        const sandbox = sbxByBinding(env, binding, sessionId);
        const full = CONTAINER_ROOT + (body.path.startsWith("/") ? body.path : `/${body.path}`);
        const dir = full.slice(0, full.lastIndexOf("/"));
        if (dir && dir !== CONTAINER_ROOT) {
          try { await sandbox.mkdir(dir, { recursive: true }); } catch { /* exists */ }
        }
        await sandbox.writeFile(full, body.contents);
        return cors(new Response(null, { status: 204 }));
      }

      // DELETE /api/session/:id -> destroy container
      if (request.method === "DELETE" && parts[0] === "api" && parts[1] === "session" && parts.length === 3) {
        const sessionId = parts[2]!;
        const binding = CONTAINER_BINDING[containerOf(sessionId)];
        if (!binding) return json({ error: `unknown session container: ${sessionId}` }, 400);
        const sandbox = sbxByBinding(env, binding, sessionId);
        await sandbox.destroy();
        return cors(new Response(null, { status: 204 }));
      }

      if (parts[0] === "api" && parts[1] === "health") return json({ ok: true });

      return cors(new Response("Not found", { status: 404 }));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
};

/** Poll the dev-server port from inside the container until it accepts connections. */
async function waitForPort(sandbox: SandboxLike, port: number, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  const probe = `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('up');process.exit(0)}).on('error',()=>process.exit(1))"`;
  while (Date.now() < deadline) {
    try {
      const res = await sandbox.exec(probe);
      if (res.success || /up/.test(res.stdout ?? "")) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}
