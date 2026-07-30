// Editor file-tab strip, built to frames `48:6560` (light) / `31:6438` (dark).
//
// **One open file at a time** (ADR-0023). `paths` is an array of one today — the
// shell keeps its single `active` string and selecting in the tree replaces the
// tab. Both tab states are expressed below even though only the active one ever
// renders, so real multi-file tabs later are a state change, not a restyle.
//
// The close ✕ is decorative: with a single open file there is no close action,
// and `disabled` would imply one that becomes available later. It arrives with
// multi-tab support.

import type { CSSProperties } from "react";
import { FileIcon, IconX } from "./icons/index.js";
import { theme } from "./theme.js";

/** 24px in the frames — larger than the 16px the file tree uses. */
const TAB_ICON_SIZE = 24;

export interface EditorTabsProps {
  /** Open files, in tab order. Exactly one entry until multi-tab lands. */
  paths: string[];
  active: string;
  onSelect: (path: string) => void;
}

export function EditorTabs({ paths, active, onSelect }: EditorTabsProps) {
  return (
    <div style={strip} role="tablist" aria-label="Open files">
      {paths.map((path, i) => {
        const isActive = path === active;
        return (
          <button
            key={path}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={path}
            onClick={() => onSelect(path)}
            style={tab(isActive, i === 0)}
          >
            <FileIcon path={path} size={TAB_ICON_SIZE} />
            <span style={label(isActive)}>{basename(path)}</span>
            <span style={close} aria-hidden="true">
              <IconX />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The frames label tabs by filename; the tree is what shows full paths. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

// The bottom hairline is an *inset shadow*, not a border: inset shadows paint
// above the strip's own background but below its children, so an active tab's
// opaque background covers the hairline while transparent inactive tabs let it
// through. That is exactly what the frames show, with no negative margins.
const strip: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  height: 36,
  flexShrink: 0,
  overflow: "hidden",
  // Recessed like the sidebar, which the frames paint the same colour. `surface`
  // is unusable here: it is #ffffff in light, identical to the active tab.
  background: theme.color.surfaceSunken,
  boxShadow: `inset 0 -1px 0 ${theme.color.border}`,
};

const tab = (isActive: boolean, isFirst: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: 6,
  boxSizing: "border-box",
  border: "none",
  // The frame gives the active tab a #262624 left border — light-mode `text`,
  // a near-black hairline in light mode. Read as a slip; using `border`. The
  // first tab has no left edge to divide (the sidebar toggle beside it is T2).
  borderLeft: isFirst ? "none" : `1px solid ${theme.color.border}`,
  background: isActive ? theme.color.surfaceRaised : "transparent",
  cursor: "pointer",
  whiteSpace: "nowrap",
});

const label = (isActive: boolean): CSSProperties => ({
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: "20px",
  color: isActive ? theme.color.text : theme.color.textMuted,
});

const close: CSSProperties = {
  display: "flex",
  alignItems: "center",
  color: theme.color.textMuted,
};
