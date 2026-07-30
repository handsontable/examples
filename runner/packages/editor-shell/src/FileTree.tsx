import { useState } from "react";
import { s } from "./styles.js";
import { theme } from "./theme.js";

export interface FileTreeProps {
  paths: string[];
  active: string;
  onSelect: (path: string) => void;
  /** When true, show add/rename/delete controls (CodeSandbox-style CRUD). */
  editable?: boolean;
  onAddFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onDeleteFile?: (path: string) => void;
}

/** package.json drives install/build — protect it from rename/delete. */
const PROTECTED = new Set(["/package.json"]);

function normalize(name: string): string {
  const t = name.trim().replace(/^\/+/, "");
  return t ? `/${t}` : "";
}

/** Flat, sorted file list with optional in-place CRUD. The shell contract stays
 *  (paths, active, onSelect); CRUD handlers are additive and optional. */
export function FileTree({ paths, active, onSelect, editable, onAddFile, onRenameFile, onDeleteFile }: FileTreeProps) {
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

  function commitAdd() {
    const p = normalize(newName);
    setAdding(false);
    setNewName("");
    if (p && !paths.includes(p)) { onAddFile?.(p); onSelect(p); }
    else if (p) onSelect(p);
  }
  function commitRename(oldPath: string) {
    const p = normalize(renameVal);
    setRenaming(null);
    setRenameVal("");
    if (p && p !== oldPath && !paths.includes(p)) { onRenameFile?.(oldPath, p); onSelect(p); }
  }

  return (
    <nav style={s.sidebar} aria-label="Files">
      {editable && (
        <div style={headerRow}>
          <span style={headerLabel}>Files</span>
          <button type="button" style={iconBtn} title="New file" onClick={() => { setAdding(true); setRenaming(null); }}>
            +
          </button>
        </div>
      )}

      {adding && (
        <input
          autoFocus
          style={editInput}
          value={newName}
          placeholder="path/to/file.tsx"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitAdd();
            if (e.key === "Escape") { setAdding(false); setNewName(""); }
          }}
          onBlur={commitAdd}
        />
      )}

      {sorted.map((p) =>
        renaming === p ? (
          <input
            key={p}
            autoFocus
            style={editInput}
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(p);
              if (e.key === "Escape") { setRenaming(null); setRenameVal(""); }
            }}
            onBlur={() => commitRename(p)}
          />
        ) : (
          <div key={p} style={fileRow(p === active)}>
            <button
              type="button"
              style={{
                ...s.fileItem(p === active),
                flex: 1,
                minWidth: 0,
                border: "none",
                background: "none",
                textAlign: "left",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              onClick={() => onSelect(p)}
              title={p}
            >
              {p.replace(/^\//, "")}
            </button>
            {editable && !PROTECTED.has(p) && (
              <span style={rowActions}>
                <button
                  type="button"
                  style={iconBtn}
                  title="Rename"
                  onClick={() => { setRenaming(p); setRenameVal(p.replace(/^\//, "")); setAdding(false); }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  style={{ ...iconBtn, color: theme.color.danger }}
                  title="Delete"
                  onClick={() => onDeleteFile?.(p)}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        ),
      )}
    </nav>
  );
}

const headerRow: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "6px 8px 6px 12px", borderBottom: `1px solid ${theme.color.border}`,
};
const headerLabel: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 11, textTransform: "uppercase",
  letterSpacing: 0.5, color: theme.color.textMuted,
};
const fileRow = (activeRow: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center",
  background: activeRow ? theme.color.surfaceMuted : "transparent",
});
const rowActions: React.CSSProperties = { display: "flex", gap: 2, paddingRight: 6, flexShrink: 0 };
const iconBtn: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer",
  color: theme.color.textMuted, fontSize: 13, lineHeight: 1, padding: "2px 5px", borderRadius: 4,
};
const editInput: React.CSSProperties = {
  width: "calc(100% - 16px)", margin: "2px 8px", boxSizing: "border-box",
  fontFamily: theme.font.mono, fontSize: 12, padding: "4px 6px",
  border: `1px solid ${theme.color.accent}`, borderRadius: 6,
  // Raised, not `surface`: this floats over the recessed sidebar, which is
  // #000000 in dark — `surface` (#070604) would be all but invisible against it.
  background: theme.color.surfaceRaised, color: theme.color.text,
};
