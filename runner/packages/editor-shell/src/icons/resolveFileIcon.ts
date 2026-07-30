// Map a file path to its seti-ui icon (DEV-2155 / ADR-0024).
//
// Resolution order, most specific first:
//   1. exact basename        — "tsconfig.json", "vite.config.ts"
//   2. substring            — upstream's `.icon-partial` rules, so "LICENSE.txt"
//                              gets the licence glyph and not the `.txt` one
//   3. longest dotted suffix — ".test.ts" before ".ts"; also covers dotfiles
//                              (".gitignore" is the whole basename) and plain
//                              extensions (the last iteration)
//   4. the generic `default` icon
//
// Keep in step with `replayResolve()` in scripts/sync-seti-icons.mjs — that
// replay is what gates the fallback behaviour, since the package has no build
// step and the repo has no DOM test runner.

import {
  SETI_BY_NAME,
  SETI_BY_PARTIAL,
  SETI_BY_SUFFIX,
  SETI_FALLBACK,
  SETI_FOLDER,
  SETI_GEOMETRY,
  type SetiEntry,
  type SetiGeometry,
} from "./generated/seti.js";

export type ResolvedFileIcon = {
  /** seti icon name, e.g. "typescript". Useful as a test hook / data attribute. */
  readonly name: string;
  /** Upstream brand colour for this file type. */
  readonly color: string;
  readonly geometry: SetiGeometry;
};

function geometryOf(entry: SetiEntry): ResolvedFileIcon {
  const geometry = SETI_GEOMETRY[entry.icon] ?? SETI_GEOMETRY[SETI_FALLBACK.icon];
  if (!geometry) {
    // Unreachable: the generator refuses to emit a table whose icons lack
    // geometry, and always emits the fallback.
    throw new Error(`seti icon "${entry.icon}" has no geometry`);
  }
  return { name: entry.icon, color: entry.color, geometry };
}

/** Resolve a file path or bare filename to an icon. Never throws for unknown types. */
export function resolveFileIcon(pathOrName: string): ResolvedFileIcon {
  const base = pathOrName.split("/").pop() ?? pathOrName;

  const byName = SETI_BY_NAME[base];
  if (byName) return geometryOf(byName);

  for (const entry of SETI_BY_PARTIAL) {
    if (base.includes(entry.match)) return geometryOf(entry);
  }

  const parts = base.split(".");
  for (let i = 1; i < parts.length; i += 1) {
    const bySuffix = SETI_BY_SUFFIX[`.${parts.slice(i).join(".")}`];
    if (bySuffix) return geometryOf(bySuffix);
  }

  return geometryOf(SETI_FALLBACK);
}

/** The folder icon used for directory rows. Static — expansion is a separate chevron. */
export function resolveFolderIcon(): ResolvedFileIcon {
  return geometryOf(SETI_FOLDER);
}
