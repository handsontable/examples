// Validation for headless demo creation over the MCP service path (DEV-2501).
//
// The browser paths get their files from the editor, which can only hold what the
// FILES panel accepted (text only, ADR-0031). This path gets them from an agent, so
// the same guarantees have to be re-established here — the request is the only thing
// we can trust, and a build is not free.

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

/**
 * The author a service call asserts. Kept next to the file rules because it is the
 * other half of trusting this request: the shared secret says *a* trusted service is
 * calling, the address says *whose* demo this becomes.
 */
export function isTeamEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@handsontable\.com$/i.test(value.trim());
}
