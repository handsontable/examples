// The editor column's 36px bar (`72:15811`): sidebar toggle + file tabs.
//
// One tab at a time — the shell still keeps a single `active` path. The design
// draws two tabs; real multi-tab state is T4's, and the strip moves into
// `EditorTabs.tsx` then. The shape ships now because T2's acceptance is that the
// anonymous view matches the frames, and the frames show tabs.

import { FileIcon, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconX } from "./icons/index.js";
import { s } from "./styles.js";

export interface EditorBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** The open file, or "" when the tab was closed. */
  active: string;
  /** Close the tab, leaving the editor pane empty until a file is picked. */
  onClose: () => void;
}

export function EditorBar({ sidebarOpen, onToggleSidebar, active, onClose }: EditorBarProps) {
  const name = active.replace(/^.*\//, "");
  return (
    <div style={s.bar}>
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

      {active && (
        <div style={s.tab(true)} aria-current="page">
          <FileIcon path={active} size={24} />
          {name}
          <button
            type="button"
            className="hot-icon-btn"
            style={{ ...s.iconButton, width: 24, height: 24 }}
            onClick={onClose}
            aria-label={`Close ${name}`}
            title={`Close ${name}`}
          >
            <IconX />
          </button>
        </div>
      )}
    </div>
  );
}
