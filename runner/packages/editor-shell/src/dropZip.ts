// Expanding a dropped `.zip` into workspace files (DEV-2531).
//
// The forum case, and the reason this exists: a user attaches a zip of the project
// that does not work for them. Before this, support unzipped it locally first —
// the one manual step between "here is my broken project" and "it is running at
// the version you like". The other direction already worked: Download hands out a
// zip of the whole workspace.
//
// `fflate` is already in the tree (the app's Download uses `zipSync`), so reading
// is `unzipSync` — a synchronous, in-memory inflate, which is right for the sizes
// a drop is allowed to be and keeps this a pure function.
//
// Everything a folder drop refuses, this refuses too, and for the same reasons —
// `dropFiles.ts` owns those rules and they are applied to the *entries*, not to
// the archive. Two rules exist only here: strip a single common root directory
// (archives are usually `project/…`), and refuse traversal paths outright.

import { unzipSync } from "fflate";

// No sibling import, deliberately: `pipeline/*.test.mjs` runs these sources through
// `--experimental-strip-types`, which cannot resolve a `./dropFiles.js` specifier
// with no build output. So the rules arrive as an argument — which also means the
// test passes the *real* ones and proves it is those that get applied.

export interface ZipFile {
  path: string;
  contents: string;
}

export interface ZipRejection {
  path: string;
  reason: string;
}

/** The drop's rules, owned by `dropFiles.ts` and handed in by `FileTree`. */
export interface ZipRules {
  isTextFileName(name: string): boolean;
  isExcludedPath(path: string): boolean;
  maxFileBytes: number;
}

/** Total unpacked bytes one archive may contribute. A zip is small and its
 *  contents are not: 4 MB of text is far more than any example needs, and the
 *  cap is what stops a decompression bomb from filling the tab's memory. */
export const MAX_ZIP_UNPACKED_BYTES = 4 * 1024 * 1024;

export interface ZipExpansion {
  files: ZipFile[];
  rejected: ZipRejection[];
  /** Set when the archive itself is unusable — nothing was taken from it. */
  error?: string;
}

/** `.zip` by name. The bytes are checked separately, by trying to read them. */
export function isZipFileName(name: string): boolean {
  return /\.zip$/i.test(name);
}

/**
 * Entry paths that must never be resolved: `..` anywhere, an absolute path, a
 * Windows drive, or backslash separators used as directories. A zip is the one
 * input here whose paths come from a stranger's filesystem.
 */
function isUnsafeEntryPath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  if (path.includes("\\")) return true;
  // Only `..` is traversal. A `.` segment is how some zip tools spell "here"
  // (`./src/index.js`), and refusing those threw away entire archives.
  return path.split("/").some((segment) => segment === "..");
}

/** Drop the `.` segments a zip tool may have written, so `./src/a.js` is `src/a.js`. */
function normalizeEntryPath(path: string): string {
  return path.split("/").filter((segment) => segment !== "." && segment !== "").join("/");
}

/**
 * The single directory every entry sits under, or "" when there is not one.
 * `project/src/a.ts` + `project/package.json` -> `project`; a zip whose entries
 * are already at the root, or which has two roots, keeps its paths.
 */
export function commonRoot(paths: string[]): string {
  const tops = new Set<string>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    // A file at the archive root means there is no single directory to strip.
    if (slash <= 0) return "";
    tops.add(path.slice(0, slash));
    if (tops.size > 1) return "";
  }
  return tops.size === 1 ? [...tops][0]! : "";
}

/** UTF-8, and only if it really is text: a replacement char or a NUL means the
 *  entry was binary with a text-looking name, which the workspace cannot hold. */
function decodeText(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // U+FFFD is what a non-UTF-8 byte decodes to; a NUL is what a binary with a
  // text-looking extension almost always contains.
  if (text.includes("\u0000") || text.includes("\uFFFD")) return null;
  return text.replace(/\r\n/g, "\n");
}

/**
 * Read an archive into workspace-relative files.
 *
 * Order is deliberate: unsafe paths are refused before anything is decoded, and
 * every other refusal names the entry rather than failing the drop — a project
 * zip almost always contains *something* we do not take (a `.png`, a lockfile),
 * and refusing the whole thing over it would make the feature useless.
 */
export function expandZip(
  bytes: Uint8Array,
  rules: ZipRules,
  limit = MAX_ZIP_UNPACKED_BYTES,
): ZipExpansion {
  // Two passes, and the order matters. The first reads the central directory only —
  // names and *declared* sizes — so every decision about what to take is made before
  // a single entry is inflated. Deciding afterwards would mean a 1 MB archive of
  // zeros could expand to gigabytes in the tab before any cap was consulted.
  let listing: Array<{ path: string; size: number }>;
  try {
    listing = [];
    unzipSync(bytes, {
      filter: (file) => {
        if (!file.name.endsWith("/")) listing.push({ path: file.name, size: file.originalSize ?? 0 });
        return false;
      },
    });
  } catch (e) {
    return { files: [], rejected: [], error: `not a readable .zip (${(e as Error).message})` };
  }

  if (!listing.length) return { files: [], rejected: [], error: "the archive is empty" };

  const root = commonRoot(listing.map((entry) => normalizeEntryPath(entry.path)));
  const rejected: ZipRejection[] = [];
  const wanted = new Map<string, string>();
  let declared = 0;

  for (const { path, size } of [...listing].sort((a, b) => a.path.localeCompare(b.path))) {
    const normalized = normalizeEntryPath(path);
    const relative = root ? normalized.slice(root.length + 1) : normalized;
    // The *raw* path, deliberately: normalising strips the leading slash off
    // `/etc/passwd`, which defangs it but also hides that the archive asked for an
    // absolute path at all. An entry that asked deserves to be named.
    if (isUnsafeEntryPath(path) || !relative) {
      rejected.push({ path: relative || path, reason: "unsafe path in the archive" });
      continue;
    }
    if (rules.isExcludedPath(relative)) continue;

    const name = relative.slice(relative.lastIndexOf("/") + 1);
    if (!rules.isTextFileName(name)) {
      rejected.push({ path: relative, reason: "not a text file" });
      continue;
    }
    if (size > rules.maxFileBytes) {
      rejected.push({ path: relative, reason: `larger than ${Math.floor(rules.maxFileBytes / 1024)} KB` });
      continue;
    }
    if (declared + size > limit) {
      rejected.push({ path: relative, reason: "archive is too large to unpack" });
      continue;
    }
    declared += size;
    wanted.set(path, relative);
  }

  // Second pass: inflate only what survived, and only up to what it declared.
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (file) => wanted.has(file.name) });
  } catch (e) {
    return { files: [], rejected: [], error: `not a readable .zip (${(e as Error).message})` };
  }

  const files: ZipFile[] = [];
  for (const [path, relative] of wanted) {
    const data = entries[path];
    if (!data) continue;
    // A header can lie about its size; the real bytes are the authority.
    if (data.length > rules.maxFileBytes) {
      rejected.push({ path: relative, reason: `larger than ${Math.floor(rules.maxFileBytes / 1024)} KB` });
      continue;
    }
    const text = decodeText(data);
    if (text === null) {
      rejected.push({ path: relative, reason: "not a text file" });
      continue;
    }
    files.push({ path: relative, contents: text });
  }

  return { files, rejected };
}
