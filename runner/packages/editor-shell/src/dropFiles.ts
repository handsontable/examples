// Reading a drag & drop onto the FILES section (DEV-2500) into workspace files.
//
// Kept free of React and of the DOM types so `pipeline/drop-files.test.mjs` can
// drive it with fakes: everything the browser supplies is described here as a
// minimal interface, and the traversal only ever touches those.
//
// TEXT ONLY, deliberately. A workspace is `Record<string, string>` end to end —
// the starter importer refuses binaries the same way (`BINARY_EXT` there records
// the path and drops the bytes), and `POST /api/session/:id/file` takes
// `{ path, contents }` as text. A dropped .png has nowhere to live yet, so it is
// refused with a message rather than silently ignored or written as mojibake.
//
// ONE EXCEPTION: a `.zip` (DEV-2531). It is still not stored — it is unpacked, and
// every entry then faces exactly these rules. The unpacker is injected rather than
// imported so this module stays free of dependencies and `pipeline/drop-files.test.mjs`
// can drive the zip branch with a fake; `dropZip.ts` is the real one.

/** Matches the importer's MAX_TEXT_BYTES — one place decides "too big to inline". */
export const MAX_DROP_FILE_BYTES = 512 * 1024;

/** Ceiling on one drop. A dropped project directory is usually a mistake; this
 *  keeps it from becoming a 400-file workspace nobody can undo. */
export const MAX_DROP_FILES = 50;

/** Ceiling on a dropped archive's own bytes, checked before it is read into memory. */
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

/** Extensions that can be dropped. An allowlist, not a binary denylist: an
 *  unknown extension is far more likely to be an asset than a source file, and
 *  the failure mode of guessing wrong is a corrupted file in the editor. */
const TEXT_EXTENSIONS = new Set([
  // sources
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro",
  // markup & styles
  "html", "htm", "css", "scss", "sass", "less", "svg",
  // data & config
  "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "csv", "tsv", "env",
  // prose
  "md", "mdx", "txt",
  // misc text
  "graphql", "gql", "sh", "handlebars", "hbs", "ejs", "pug",
]);

/** Extensionless files that are still text and worth accepting. */
const TEXT_FILENAMES = new Set([
  "README", "LICENSE", "CHANGELOG", "Dockerfile", "Procfile",
  ".gitignore", ".npmrc", ".nvmrc", ".editorconfig", ".prettierrc", ".browserslistrc",
]);

/** Directories never worth carrying into a workspace. Mirrors the importer's
 *  EXCLUDE_DIRS — dropping a project folder should not drag in its build output. */
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".cache", "dist", "build", "out",
  ".next", ".nuxt", ".output", ".astro", ".angular", ".vite",
  ".codesandbox", ".devcontainer", ".vscode", ".idea",
]);

/** Lockfiles the workspace resolves for itself; a dropped one is stale by definition. */
const EXCLUDE_FILES = new Set(["package-lock.json", "yarn.lock", ".DS_Store", "Thumbs.db"]);

/** `.env` files can carry real credentials. Never accept one, whatever its suffix. */
const SECRET_FILENAME_RE = /^\.env(\..+)?$/i;

/**
 * Is this relative path one a drop skips silently — build output, a lockfile, a
 * `.git` directory? Silently, because unlike a refused file these are never what
 * somebody meant to hand over, so naming them is noise.
 *
 * Exported for the zip expander, which walks paths rather than directory entries
 * and must answer the same question the traversal below answers per level.
 */
export function isExcludedPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "";
  if (EXCLUDE_FILES.has(name)) return true;
  return segments.slice(0, -1).some((dir) => EXCLUDE_DIRS.has(dir));
}

/** A file the caller can hand to the workspace. */
export interface DroppedFile {
  path: string;
  contents: string;
}

export interface RejectedFile {
  path: string;
  reason: string;
}

export interface DropResult {
  files: DroppedFile[];
  rejected: RejectedFile[];
  /** True when MAX_DROP_FILES cut the drop short — reported, never silent. */
  truncated: boolean;
}

/** The part of `File` this module uses. `arrayBuffer` only for archives. */
export interface DropFileLike {
  name: string;
  size: number;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/** Unpacks an archive into workspace-relative files. `dropZip.ts` implements it. */
export interface ZipUnpacker {
  (bytes: Uint8Array): { files: DroppedFile[]; rejected: RejectedFile[]; error?: string };
}

export interface DropOptions {
  /** Absent ⇒ a dropped `.zip` is refused, as any other binary is. */
  unzip?: ZipUnpacker;
}

/** The part of `FileSystemEntry` this module uses (the callback-style webkit API). */
export interface DropEntryLike {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(onSuccess: (file: DropFileLike) => void, onError?: (err: unknown) => void): void;
  createReader?(): {
    readEntries(onSuccess: (entries: DropEntryLike[]) => void, onError?: (err: unknown) => void): void;
  };
}

/** Is this a text file we accept? Names, not contents — a drop has no bytes yet. */
export function isTextFileName(name: string): boolean {
  if (SECRET_FILENAME_RE.test(name)) return false;
  if (TEXT_FILENAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  // A leading dot is the whole name (".gitignore"), not an extension.
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Join a drop target directory and a relative name into a workspace path. */
export function dropPath(dir: string, relative: string): string {
  const left = dir.replace(/^\/+|\/+$/g, "");
  const right = relative.replace(/^\/+/, "");
  return left ? `/${left}/${right}` : `/${right}`;
}

/**
 * The directory a drop lands in, given the row it was dropped on. A file row
 * targets that file's *directory*, which is what "drop it next to this" means;
 * anything else targets the root.
 */
export function dropTargetDir(path: string | null, isDirectory: boolean): string {
  if (!path) return "";
  if (isDirectory) return path.replace(/^\/+/, "");
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "" : path.slice(1, slash);
}

/**
 * A free path near `path`: `/src/a.ts` -> `/src/a-1.ts`, `-2`, … Used by the
 * collision dialog's "Keep both", so an accidental re-drop cannot overwrite
 * unsaved work.
 */
export function uniquePath(path: string, taken: (candidate: string) => boolean): string {
  if (!taken(path)) return path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

function entryFile(entry: DropEntryLike): Promise<DropFileLike> {
  return new Promise((resolve, reject) => {
    if (!entry.file) {
      reject(new Error(`entry ${entry.name} is not readable as a file`));
      return;
    }
    entry.file(resolve, reject);
  });
}

/**
 * One `readEntries` call returns at most ~100 entries and an empty array means
 * "done" — a single call silently truncates a large directory, so keep calling.
 */
async function directoryEntries(entry: DropEntryLike): Promise<DropEntryLike[]> {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const all: DropEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<DropEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/** Accept one file into `result`, or record why it was refused. */
async function takeFile(
  result: DropResult,
  path: string,
  file: DropFileLike,
  options: DropOptions = {},
): Promise<void> {
  if (isZipName(file.name)) {
    await takeArchive(result, path, file, options);
    return;
  }
  if (!isTextFileName(file.name)) {
    result.rejected.push({ path, reason: "not a text file" });
    return;
  }
  if (file.size > MAX_DROP_FILE_BYTES) {
    result.rejected.push({ path, reason: `larger than ${Math.floor(MAX_DROP_FILE_BYTES / 1024)} KB` });
    return;
  }
  result.files.push({ path, contents: normalizeEol(await file.text()) });
}

/** `.zip` by name; the bytes are checked by trying to read them. */
function isZipName(name: string): boolean {
  return /\.zip$/i.test(name);
}

/**
 * Unpack an archive *into the directory it was dropped on*, so a zip of `src/` and
 * `package.json` lands as a project rather than as a folder named after the file.
 *
 * The archive's own cap is separate from the drop's: an unreadable zip is one
 * rejection, and `MAX_DROP_FILES` still governs how much of it is taken.
 */
async function takeArchive(
  result: DropResult,
  path: string,
  file: DropFileLike,
  options: DropOptions,
): Promise<void> {
  if (!options.unzip || !file.arrayBuffer) {
    result.rejected.push({ path, reason: "not a text file" });
    return;
  }
  // Bound the archive before reading it: everything downstream is in memory, and an
  // 8 MB zip already holds far more text than a demo can.
  if (file.size > MAX_ARCHIVE_BYTES) {
    result.rejected.push({
      path,
      reason: `archive larger than ${Math.floor(MAX_ARCHIVE_BYTES / (1024 * 1024))} MB`,
    });
    return;
  }
  const dir = path.slice(0, path.lastIndexOf("/"));
  const expansion = options.unzip(new Uint8Array(await file.arrayBuffer()));
  if (expansion.error) {
    result.rejected.push({ path, reason: expansion.error });
    return;
  }
  // Refusals first. Taking the files first meant the drop's ceiling could return
  // early and swallow them — including the `.env` the reader most needs to hear was
  // refused, since a refusal nobody sees is indistinguishable from an acceptance.
  for (const entry of expansion.rejected) {
    result.rejected.push({ path: dropPath(dir, entry.path), reason: entry.reason });
  }
  for (const entry of expansion.files) {
    if (result.files.length >= MAX_DROP_FILES) {
      result.truncated = true;
      return;
    }
    result.files.push({ path: dropPath(dir, entry.path), contents: entry.contents });
  }
}

/** Match the importer: workspaces store LF, so a Windows-authored drop is normalized. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Walk dropped entries (files and directories, recursively) into workspace files.
 *
 * `entries` must be collected from `DataTransferItem.webkitGetAsEntry()`
 * synchronously inside the drop handler — the DataTransfer is emptied the moment
 * that handler returns, so awaiting first loses the drop.
 */
export async function collectDroppedEntries(
  entries: DropEntryLike[],
  targetDir = "",
  options: DropOptions = {},
): Promise<DropResult> {
  const result: DropResult = { files: [], rejected: [], truncated: false };
  const queue: Array<{ entry: DropEntryLike; dir: string }> = entries.map((entry) => ({
    entry,
    dir: targetDir,
  }));

  while (queue.length) {
    if (result.files.length >= MAX_DROP_FILES) {
      result.truncated = true;
      return result;
    }
    const { entry, dir } = queue.shift()!;
    if (entry.isDirectory) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      const children = await directoryEntries(entry);
      const childDir = dir ? `${dir}/${entry.name}` : entry.name;
      queue.push(...children.map((child) => ({ entry: child, dir: childDir })));
      continue;
    }
    if (!entry.isFile || EXCLUDE_FILES.has(entry.name)) continue;
    await takeFile(result, dropPath(dir, entry.name), await entryFile(entry), options);
  }

  return result;
}

/**
 * Fallback for a drop that exposes no filesystem entries (`webkitGetAsEntry()`
 * returning null): plain `File` objects, which carry a name but no directory, so
 * every one lands directly in the target directory.
 */
export async function collectDroppedFiles(
  files: DropFileLike[],
  targetDir = "",
  options: DropOptions = {},
): Promise<DropResult> {
  const result: DropResult = { files: [], rejected: [], truncated: false };
  for (const file of files) {
    if (result.files.length >= MAX_DROP_FILES) {
      result.truncated = true;
      return result;
    }
    if (EXCLUDE_FILES.has(file.name)) continue;
    await takeFile(result, dropPath(targetDir, file.name), file, options);
  }
  return result;
}

/** One line for the FILES header: what a drop refused, and why. */
export function rejectionMessage(result: DropResult): string | null {
  const parts: string[] = [];
  if (result.rejected.length) {
    const names = result.rejected.slice(0, 2).map((r) => `${basename(r.path)} (${r.reason})`);
    const rest = result.rejected.length - names.length;
    parts.push(`Skipped ${names.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`);
  }
  if (result.truncated) parts.push(`Stopped at ${MAX_DROP_FILES} files.`);
  return parts.length ? parts.join(" ") : null;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
