// The shell's single icon surface (DEV-2155 / ADR-0024). Two families:
// tabler-icons for UI chrome, seti-ui for file types. Re-exported from the
// package barrel (`src/index.ts`), because `editor-shell` has no `exports` map —
// both consumers alias the bare specifier straight to the barrel, so
// `@handsontable/demo-editor-shell/icons` would not resolve.

export * from "./ui.js";
export { FileIcon, FolderIcon } from "./FileIcon.js";
export type { FileIconProps } from "./FileIcon.js";
export { resolveFileIcon, resolveFolderIcon } from "./resolveFileIcon.js";
export type { ResolvedFileIcon } from "./resolveFileIcon.js";
export type { SetiEntry, SetiGeometry, SetiPath } from "./generated/seti.js";
