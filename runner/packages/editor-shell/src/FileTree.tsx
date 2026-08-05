// The FILES section: a real folder tree over the flat `FilesMap` key set (`31:6438`).
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Dialog } from "./Dialog.js";
import {
  FileIcon,
  FolderIcon,
  IconChevronDown,
  IconChevronRight,
  IconDownload,
  IconFolderPlus,
  IconPencil,
  IconPlus,
  IconTrashX,
} from "./icons/index.js";
import { SectionHeader, iconBtn } from "./SectionHeader.js";
import { theme } from "./theme.js";

export interface FileTreeProps {
  paths: string[];
  active: string;
  onSelect: (path: string) => void;
  /** Section collapse, owned by `Sidebar`. */
  collapsed: boolean;
  onToggle: () => void;
  /** Zips the live workspace. Present in every mode — this is not a CRUD control. */
  onDownloadAll?: () => void;
  /** When true, show add/rename/delete controls (CodeSandbox-style CRUD). */
  editable?: boolean;
  onAddFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onDeleteFile?: (path: string) => void;
}

/** package.json drives install/build — protect it from rename/delete. */
const PROTECTED = new Set(["/package.json"]);

type TreeNode =
  | { kind: "dir"; name: string; path: string; depth: number; children: TreeNode[] }
  | { kind: "file"; name: string; path: string; depth: number };

interface Acc {
  dirs: Map<string, Acc>;
  /** basename -> full path, so a file node keeps the exact key `files` is indexed by. */
  files: Map<string, string>;
}

/** Flat `["/src/main.ts", …]` -> nested nodes, directories first and alphabetical within
 *  each level. A directory exists only as some file's path prefix: `FilesMap` is a flat
 *  `Record<string, string>`, so an empty directory is not representable. */
export function buildFileTree(paths: string[]): TreeNode[] {
  const root: Acc = { dirs: new Map(), files: new Map() };

  for (const p of paths) {
    const segs = p.replace(/^\/+/, "").split("/").filter(Boolean);
    if (!segs.length) continue;
    let cur = root;
    for (const seg of segs.slice(0, -1)) {
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.set(segs[segs.length - 1]!, p);
  }

  const walk = (acc: Acc, prefix: string, depth: number): TreeNode[] => [
    ...[...acc.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]): TreeNode => {
        const path = `${prefix}/${name}`;
        return { kind: "dir", name, path, depth, children: walk(sub, path, depth + 1) };
      }),
    ...[...acc.files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, path]): TreeNode => ({ kind: "file", name, path, depth })),
  ];

  return walk(root, "", 0);
}

function flatten(nodes: TreeNode[], isCollapsed: (path: string) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (n.kind === "dir" && !isCollapsed(n.path)) out.push(...flatten(n.children, isCollapsed));
  }
  return out;
}

function normalize(name: string): string {
  const t = name.trim().replace(/^\/+/, "");
  return t ? `/${t}` : "";
}

export function FileTree({
  paths,
  active,
  onSelect,
  collapsed,
  onToggle,
  onDownloadAll,
  editable,
  onAddFile,
  onRenameFile,
  onDeleteFile,
}: FileTreeProps) {
  const tree = useMemo(() => buildFileTree(paths), [paths]);

  // Collapsed dirs, not expanded ones: `props.files` is replaced wholesale on every
  // example switch, and a seeded expanded-set would leave the new file set's folders
  // shut. Storing the negation makes default-expanded survive that churn for free.
  const [shutDirs, setShutDirs] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [adding, setAdding] = useState<"file" | "folder" | null>(null);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  // Deletion is confirmed, not immediate: the trash icon sits 8px from Rename on a
  // 24px row that only reveals its actions on hover, and the delete it fires is
  // unrecoverable from inside the app — `onDeleteFile` drops the file from the
  // workspace and there is no undo.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const rows = useMemo(() => flatten(tree, (p) => shutDirs.has(p)), [tree, shutDirs]);

  // Derived, not the raw state: `paths` is replaced wholesale on an example switch,
  // which would otherwise leave the dialog asking about a file that is no longer here.
  const confirming = pendingDelete && paths.includes(pendingDelete) ? pendingDelete : null;

  // …and the state itself has to go, not just its rendering. A path that leaves and
  // *comes back* — switch example away and back, or re-add the same name — would
  // otherwise re-open this dialog unprompted, asking about a delete nobody started.
  useEffect(() => {
    if (pendingDelete && !paths.includes(pendingDelete)) setPendingDelete(null);
  }, [paths, pendingDelete]);

  function toggleDir(path: string) {
    setShutDirs((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  function startAdd(kind: "file" | "folder") {
    setAdding(kind);
    setNewName("");
    setRenaming(null);
  }

  function commitAdd() {
    const p = normalize(newName);
    setAdding(null);
    setNewName("");
    if (p && !paths.includes(p)) {
      onAddFile?.(p);
      onSelect(p);
    } else if (p) onSelect(p);
  }

  function commitRename(oldPath: string) {
    const p = normalize(renameVal);
    setRenaming(null);
    setRenameVal("");
    if (p && p !== oldPath && !paths.includes(p)) {
      onRenameFile?.(oldPath, p);
      onSelect(p);
    }
  }

  return (
    <section style={section} aria-label="Files">
      <SectionHeader
        label="Files"
        collapsed={collapsed}
        onToggle={onToggle}
        actions={
          <>
            {onDownloadAll && (
              <button
                type="button"
                className="hot-icon-btn"
                style={iconBtn}
                title="Download this workspace (including your edits) as a .zip"
                onClick={onDownloadAll}
              >
                <IconDownload />
              </button>
            )}
            {/* Only these two are gated — the download control above and the collapse
                chevron after them must render in every mode. */}
            {editable && (
              <>
                <button
                  type="button"
                  className="hot-icon-btn"
                  style={iconBtn}
                  title="New file in a new folder"
                  onClick={() => startAdd("folder")}
                >
                  <IconFolderPlus />
                </button>
                <button
                  type="button"
                  className="hot-icon-btn"
                  style={iconBtn}
                  title="New file"
                  onClick={() => startAdd("file")}
                >
                  <IconPlus />
                </button>
              </>
            )}
          </>
        }
      />

      {!collapsed && (
        <div style={body}>
          {adding && (
            <input
              autoFocus
              style={editInput}
              value={newName}
              // Both buttons commit through `onAddFile`: an empty directory cannot exist
              // in a flat FilesMap, so "new folder" is really "new file under a new prefix".
              placeholder={adding === "folder" ? "folder/file.ts" : "file.ts"}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAdd();
                if (e.key === "Escape") {
                  setAdding(null);
                  setNewName("");
                }
              }}
              onBlur={commitAdd}
            />
          )}

          {rows.map((node) =>
            node.kind === "file" && renaming === node.path ? (
              <input
                key={node.path}
                autoFocus
                style={editInput}
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(node.path);
                  if (e.key === "Escape") {
                    setRenaming(null);
                    setRenameVal("");
                  }
                }}
                onBlur={() => commitRename(node.path)}
              />
            ) : node.kind === "dir" ? (
              <div key={node.path} className="hot-file-row" style={row}>
                <button
                  type="button"
                  style={rowButton}
                  aria-expanded={!shutDirs.has(node.path)}
                  onClick={() => toggleDir(node.path)}
                  title={node.path}
                >
                  <Indent depth={node.depth} />
                  <span style={slot}>
                    {shutDirs.has(node.path) ? <IconChevronRight /> : <IconChevronDown />}
                  </span>
                  <FolderIcon />
                  <span style={label(true)}>{node.name}</span>
                </button>
              </div>
            ) : (
              <div
                key={node.path}
                className="hot-file-row"
                data-active={node.path === active ? "true" : undefined}
                style={row}
              >
                <button
                  type="button"
                  style={rowButton}
                  onClick={() => onSelect(node.path)}
                  title={node.path}
                >
                  {/* A file sits one slot deeper than its own depth so its icon lines up
                      with a sibling directory's icon, past that directory's chevron. */}
                  <Indent depth={node.depth + 1} />
                  <FileIcon path={node.path} />
                  <span style={label(node.path === active)}>{node.name}</span>
                </button>
                {editable && !PROTECTED.has(node.path) && (
                  <span className="hot-row-actions" style={rowActions}>
                    <button
                      type="button"
                      style={iconBtn}
                      title="Rename"
                      onClick={() => {
                        setRenaming(node.path);
                        setRenameVal(node.path.replace(/^\//, ""));
                        setAdding(null);
                      }}
                    >
                      <IconPencil />
                    </button>
                    <button
                      type="button"
                      style={{ ...iconBtn, color: theme.color.danger }}
                      title="Delete"
                      onClick={() => {
                        setPendingDelete(node.path);
                        setAdding(null);
                        setRenaming(null);
                      }}
                    >
                      <IconTrashX />
                    </button>
                  </span>
                )}
              </div>
            ),
          )}
        </div>
      )}

      {/* Outside the `!collapsed` branch on purpose: collapsing the section while the
          dialog is open must not strand a modal whose owner stopped rendering.

          No busy state and no in-flight guard, unlike the demo-delete confirm in
          `MyDemos`: `onDeleteFile` is a synchronous in-memory splice of the workspace,
          not a network revocation, so there is nothing to be mid-flight. */}
      {confirming && (
        <Dialog title="Delete this file?" onClose={() => setPendingDelete(null)}>
          <p style={confirmBody}>
            <strong>{confirming}</strong> and any unsaved edits in it will be removed from
            this workspace. Nothing is persisted until you save or fork.
          </p>
          <div style={confirmFooter}>
            {/* "Delete file", not "Delete": the row's trash control is already named
                "Delete" by its `title`, and two same-named buttons make every
                unscoped test locator ambiguous while this dialog is open. */}
            <button
              type="button"
              style={dangerButton}
              onClick={() => {
                onDeleteFile?.(confirming);
                setPendingDelete(null);
              }}
            >
              Delete file
            </button>
            {/* Focus lands here, not on Delete file — see `Dialog`'s `data-autofocus`
                note: the destructive control is first in the DOM, so focusing it would
                let Space or Enter carry out the delete this dialog exists to ask about. */}
            <button
              type="button"
              data-autofocus
              style={ghostButton}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** One 16px slot per level, gaps included — the design aligns rows on the chevron column. */
function Indent({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return <span style={{ width: depth * 16 + (depth - 1) * 4, flex: "0 0 auto" }} />;
}

const section: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const body: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  // The scroll lives here, not on the sidebar: DEPENDENCIES is pinned to the bottom
  // and would scroll away with the list otherwise.
  overflowY: "auto",
  minHeight: 0,
  background: theme.color.surface,
};

// No `background` here on purpose. Both the active and hover fills live in the app's
// global stylesheet, keyed off `data-active`: an inline background — even
// `transparent` — outranks a stylesheet `:hover` rule, so setting it here would
// silently kill the row hover the design calls for.
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: 24,
  padding: `0 ${theme.space(3)}`,
  overflow: "clip",
  flex: "0 0 auto",
};

const rowButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(1),
  flex: 1,
  minWidth: 0,
  border: "none",
  background: "none",
  padding: 0,
  cursor: "pointer",
  textAlign: "left",
};

const slot: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  flex: "0 0 auto",
  color: theme.color.textMuted,
};

const label = (strong: boolean): CSSProperties => ({
  fontFamily: theme.font.ui,
  fontSize: 10,
  lineHeight: "16px",
  color: strong ? theme.color.text : theme.color.textMuted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const rowActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  paddingLeft: theme.space(2),
  flexShrink: 0,
};

const confirmBody: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: theme.color.textMuted,
};

const confirmFooter: CSSProperties = {
  display: "flex",
  gap: theme.space(2),
  marginTop: theme.space(5),
};

const ghostButton: CSSProperties = {
  height: 32,
  padding: `0 ${theme.space(3)}`,
  // `controlBorder`, not `border`: dark's `border` is #222222, the same value as the
  // `surfaceRaised` dialog card, so an outline-only button drawn with it has no
  // visible edge at all. Same trap as the top-bar buttons (d1cfb172).
  border: `1px solid ${theme.color.controlBorder}`,
  borderRadius: theme.radius.md,
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
  cursor: "pointer",
};

const dangerButton: CSSProperties = {
  ...ghostButton,
  border: `1px solid ${theme.color.danger}`,
  background: theme.color.danger,
  color: theme.color.accentContrast,
  fontWeight: 600,
};

const editInput: CSSProperties = {
  width: `calc(100% - ${theme.space(6)})`,
  margin: `2px ${theme.space(3)}`,
  boxSizing: "border-box",
  fontFamily: theme.font.mono,
  fontSize: 12,
  padding: "4px 6px",
  border: `1px solid ${theme.color.accent}`,
  borderRadius: theme.radius.sm,
  // Raised, not `surface`: this floats over the recessed sidebar, which is
  // #000000 in dark — `surface` (#070604) would be all but invisible against it.
  background: theme.color.surfaceRaised,
  color: theme.color.text,
};
