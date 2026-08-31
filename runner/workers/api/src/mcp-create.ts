// Validation for headless demo creation over the MCP service path (DEV-2501).
//
// The browser paths get their files from the editor, which can only hold what the
// FILES panel accepted (text only, ADR-0031). This path gets them from an agent, so
// the same guarantees have to be re-established here — the request is the only thing
// we can trust, and a build is not free.

// The first runtime import this file has ever had: a spec that imports it must
// now register the .js->.ts hook (pipeline/fixtures/worker-hooks.mjs) and import
// it dynamically — see guide-tracks.test.mjs / ht-version-resolve.test.mjs.
import { snapshotBuildCommand } from "./build-command.js";

/** A rejected payload. Same shape as `demo-info.ts` so the route can reply uniformly. */
export interface McpValidationError {
  error: string;
}

export function isMcpValidationError(value: unknown): value is McpValidationError {
  return typeof value === "object" && value !== null && "error" in value;
}

/**
 * Caps. A demo is an example, not an application: past ~50 files it is a project that
 * belongs in a repo, and 256 KB of source is already far more than any starter ships.
 * Both also bound what one authenticated caller can push into a container build.
 */
export const MAX_MCP_FILES = 50;
export const MAX_MCP_BYTES = 256 * 1024;

/**
 * Any basename that starts with `.env`, in any directory — `.env`, `.env.local`, and also
 * `.envrc`, which direnv fills with exactly the kind of value that must never reach a demo
 * (security review of PR #170). Narrower patterns let `.envrc` through.
 */
const ENV_FILE = /(^|\/)\.env[^/]*$/i;

/**
 * Paths whose presence means the caller sent a directory tree rather than an example.
 * They are refused rather than filtered: silently dropping files produces a demo that
 * builds into something the caller did not write, which is worse than an error.
 */
const REFUSED_DIRS =
  /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|\.output|\.astro|\.angular|\.vite|\.vscode|\.idea)\//i;

const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i;

/**
 * Validate an agent-supplied file map, or return the reason it cannot be built.
 *
 * Every path must be absolute (`/index.js`) because that is the shape `createDemo()`
 * and the build config already assume; anything else silently lands in the wrong place.
 */
export function validateMcpFiles(files: unknown): Record<string, string> | McpValidationError {
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return { error: "files must be an object mapping absolute paths to file contents" };
  }
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0) return { error: "files must not be empty" };
  if (entries.length > MAX_MCP_FILES) {
    return { error: `too many files: ${entries.length} > ${MAX_MCP_FILES}` };
  }

  let bytes = 0;
  const out: Record<string, string> = {};
  for (const [path, contents] of entries) {
    if (!path.startsWith("/")) {
      return { error: `file paths must start with "/": ${path}` };
    }
    if (path.includes("..")) return { error: `file path must not traverse: ${path}` };
    if (typeof contents !== "string") {
      return { error: `file contents must be text: ${path}` };
    }
    // Never, under any circumstances — a demo is one save away from a public link.
    if (ENV_FILE.test(path)) return { error: `refusing an env file: ${path}` };
    if (REFUSED_DIRS.test(path)) return { error: `refusing a build/vendor path: ${path}` };
    if (LOCKFILES.test(path)) return { error: `refusing a lockfile: ${path}` };
    bytes += new TextEncoder().encode(contents).length;
    if (bytes > MAX_MCP_BYTES) {
      return { error: `files too large: over ${MAX_MCP_BYTES} bytes of source` };
    }
    out[path] = contents;
  }

  // `createDemo()` builds with a package manager; without a manifest the build fails
  // deep in a container instead of here.
  if (!out["/package.json"]) return { error: "files must include /package.json" };
  return out;
}

/** npm package name per build binary, for the binaries `BUILD_CONFIG`'s build
 *  commands actually invoke. Not derivable from the name (`ng` ships in
 *  `@angular/cli`, `remix` in `@remix-run/dev`), so it is a table — and
 *  `mcp-create.test.mjs` pins that the table covers every framework in
 *  `BUILD_CONFIG`, so adding a framework without an entry fails the suite rather
 *  than costing a container boot in production. */
const BUILD_TOOL_PACKAGE: Record<string, string> = {
  vite: "vite",
  ng: "@angular/cli",
  next: "next",
  astro: "astro",
  nuxt: "nuxt",
  remix: "@remix-run/dev",
};

/**
 * Can this manifest run the framework's build command at all?
 *
 * The build command comes from the catalog, not from the payload, so a manifest
 * that does not declare its binary installs cleanly (`pnpm install` exits 0) and
 * then dies as `sh: 1: vite: not found` — after a container boot billed against
 * the spend ceiling, and as a 500 rather than something the caller can act on
 * (Sentry DEMOS-31). Decided from the request alone, so it costs nothing.
 *
 * `dependencies`, `devDependencies`, and `peerDependencies` all count: the
 * builder image runs pnpm 10.34.5 with no `.npmrc` overriding it anywhere in
 * the repo, and pnpm's `auto-install-peers` defaults to true (pnpm >=7,
 * unchanged through the 10.x line), so the non-frozen retry this path always
 * takes (lockfiles are refused) installs a peer-only declaration into
 * `node_modules/.bin` just as it would a `dependencies` one. Verified
 * empirically: `pnpm install --no-frozen-lockfile` against a manifest holding
 * only `{"peerDependencies":{"vite":"^5.4.0"}}` produces a working
 * `node_modules/.bin/vite`. Refusing a peer-only manifest would be a false
 * rejection of a demo that builds fine in the real container — worse than the
 * bug this gate exists to catch.
 */
export function validateBuildToolchain(
  files: Record<string, string>,
  buildCommand: string,
): McpValidationError | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(files["/package.json"] ?? "");
  } catch {
    return { error: "/package.json is not valid JSON" };
  }
  if (typeof manifest !== "object" || manifest === null) {
    return { error: "/package.json is not valid JSON" };
  }

  const bin = snapshotBuildCommand(buildCommand).trim().split(/\s+/)[0];
  const pkg = bin ? BUILD_TOOL_PACKAGE[bin] : undefined;
  // Unknown binary: never refuse a payload because our table is behind — the
  // coverage test is what keeps the table honest, not a production 400.
  if (!pkg) return null;

  const m = manifest as {
    dependencies?: unknown;
    devDependencies?: unknown;
    peerDependencies?: unknown;
  };
  const section = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const deps = section(m.dependencies);
  const devDeps = section(m.devDependencies);
  const peerDeps = section(m.peerDependencies);
  if (pkg in deps || pkg in devDeps || pkg in peerDeps) return null;

  return { error: `/package.json must declare "${pkg}": this demo is built with \`${bin}\`` };
}

/**
 * The author a service call asserts. Kept next to the file rules because it is the
 * other half of trusting this request: the shared secret says *a* trusted service is
 * calling, the address says *whose* demo this becomes.
 */
export function isTeamEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@handsontable\.com$/i.test(value.trim());
}

/**
 * Was this demo published by the MCP itself? The containment control from the
 * security review of PR #177: the shared secret only proves *a* trusted service is
 * calling — it says nothing about whose demos that service may rewrite — so the
 * update route is restricted to rows the MCP created, and `forked_from` is the
 * provenance stamp (`mcp:<framework>`, written by the create route and never by a
 * browser save). A leaked secret can then never touch work somebody built in the
 * browser; the blast radius stays inside what the MCP published in the first place.
 */
export function isMcpCreated(row: { forked_from?: string | null }): boolean {
  return Boolean(row.forked_from?.startsWith("mcp:"));
}
