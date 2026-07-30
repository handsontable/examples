// seti-ui file-type icons for the file tree (T3) and editor tabs (T4).
//
// Geometry is flattened to `fill="currentColor"` and coloured through the CSS
// `color` property, so a caller can override it (selection, muted rows) without
// a second code path. Colours are upstream brand values, not theme tokens —
// they're identical in light and dark, matching frames `48:6560` / `31:6438`.

import { resolveFileIcon, resolveFolderIcon, type ResolvedFileIcon } from "./resolveFileIcon.js";

export type FileIconProps = {
  /** File path or bare filename — "src/main.ts" and "main.ts" resolve alike. */
  path: string;
  /** Rendered box, px. 16 is what every frame shows. */
  size?: number;
  /** Override the upstream brand colour (e.g. to mute an ignored row). */
  color?: string;
};

function Glyph({ icon, size, color }: { icon: ResolvedFileIcon; size: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={icon.geometry.viewBox}
      fill="currentColor"
      aria-hidden="true"
      data-seti-icon={icon.name}
      style={{ color: color ?? icon.color, display: "block", flex: "0 0 auto" }}
    >
      {icon.geometry.paths.map((p, i) => (
        <path key={i} d={p.d} fillRule={p.fillRule} clipRule={p.clipRule} />
      ))}
    </svg>
  );
}

/** File-type icon. Unknown extensions fall back to seti's generic `default` glyph. */
export function FileIcon({ path, size = 16, color }: FileIconProps) {
  return <Glyph icon={resolveFileIcon(path)} size={size} color={color} />;
}

/** Directory icon. No open/closed variants — the design uses a separate chevron. */
export function FolderIcon({ size = 16, color }: Omit<FileIconProps, "path">) {
  return <Glyph icon={resolveFolderIcon()} size={size} color={color} />;
}
