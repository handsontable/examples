// Resolves which file a Sandpack sandbox boots from, and verifies that file
// actually exists in the files handed to the bundler. A catalog entry whose
// `entry` points at a file that was never generated mounts a sandbox that
// compiles "successfully" without executing anything: blank preview, no error
// banner (DEV-2130). Failing loudly here lets the shell show "Setup failed".
//
// Kept free of sandpack-client imports so it stays importable from Node tests.

import type { FilesMap } from "./types.js";

/** Environments whose entry point is the HTML file rather than a JS/TS module. */
export const HTML_ENTRY_ENVS = new Set(["parcel", "static"]);

/** Map an authored entry path to its compiled name in the parcel sandbox. */
export function toParcelEntry(path: string): string {
  return path.replace(/\.(tsx|ts|jsx)$/, ".js");
}

/**
 * Pick the sandbox entry path for `env` and throw if it is missing from
 * `files` — the map the bundler will actually see (for parcel: the
 * pre-transpiled view, where TS/JSX sources carry their compiled `.js` names).
 */
export function resolveSandboxEntry(
  env: string | undefined,
  entry: string,
  htmlEntry: string | null | undefined,
  files: FilesMap,
): string {
  const entryPath =
    env && HTML_ENTRY_ENVS.has(env) && htmlEntry
      ? htmlEntry
      : env === "parcel"
        ? toParcelEntry(entry)
        : entry;
  if (files[entryPath] === undefined) {
    throw new Error(`entry file ${entryPath} not found in example files`);
  }
  return entryPath;
}
