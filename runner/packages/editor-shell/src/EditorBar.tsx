// The editor column's 36px bar (`72:15811`): sidebar toggle + file tabs.
//
// The toggle is this file's; the tabs are `EditorTabs` (T4, DEV-2158), which
// owns their shape and the single-file rule. The two sit in one row because the
// frame draws one row — the toggle occupies `72:15812`, the tabs start at x=36 —
// and the bar carries the strip's own recessed background and inset hairline so
// there is no seam between them.

import { EditorTabs } from "./EditorTabs.js";
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from "./icons/index.js";
import { s } from "./styles.js";

export interface EditorBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Open files, in tab order. Exactly one entry until multi-tab lands. */
  paths: string[];
  active: string;
  onSelect: (path: string) => void;
}

export function EditorBar({ sidebarOpen, onToggleSidebar, paths, active, onSelect }: EditorBarProps) {
  return (
    <div style={s.editorBar}>
      <button
        type="button"
        className="hot-icon-btn"
        style={s.iconButton}
        onClick={onToggleSidebar}
        aria-pressed={sidebarOpen}
        aria-label={sidebarOpen ? "Hide the files sidebar" : "Show the files sidebar"}
        title={sidebarOpen ? "Hide the files sidebar" : "Show the files sidebar"}
      >
        {sidebarOpen ? <IconLayoutSidebarLeftCollapse /> : <IconLayoutSidebarLeftExpand />}
      </button>

      <EditorTabs paths={paths} active={active} onSelect={onSelect} />
    </div>
  );
}
