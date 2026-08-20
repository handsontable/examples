// The FILES section: a real folder tree over the flat `FilesMap` key set (`31:6438`).
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { Dialog } from "./Dialog.js";
import {
  collectDroppedEntries,
  collectDroppedFiles,
  dropTargetDir,
  isExcludedPath,
  isTextFileName,
  MAX_DROP_FILE_BYTES,
  rejectionMessage,
  uniquePath,
  type DropEntryLike,
  type DroppedFile,
} from "./dropFiles.js";
import { expandZip } from "./dropZip.js";
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
  /** Drag & drop (DEV-2500). Batched on purpose: one call per drop, not per file
   *  — N separate adds are N workspace re-renders and N pushes into a Tier-2
   *  container's dev server. Absent = no drop target (the read-only modes). */
  onAddFiles?: (files: { path: string; contents: string }[]) => void;
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
  onAddFiles,
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

  // ---- drag & drop (DEV-2500) ---------------------------------------------
  const canDrop = !!editable && !!onAddFiles;
  // dragenter/dragleave fire for every descendant the pointer crosses, so a
  // boolean would flicker off the moment the cursor entered a row. Depth counter,
  // and it lives in a ref *and* in state: the ref is the truth (synchronous
  // across the event pair), the state is what renders.
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  // A drop whose files collide with existing paths waits here for an answer.
  // The whole batch waits, not just the colliding half: a partially-applied drop
  // is impossible to reason about after the fact.
  const [collision, setCollision] = useState<{ files: DroppedFile[]; clashes: string[] } | null>(null);

  const rows = useMemo(() => flatten(tree, (p) => shutDirs.has(p)), [tree, shutDirs]);

  function endDrag() {
    dragDepth.current = 0;
    setDropping(false);
    setDropTargetPath(null);
  }

  /** Commit a batch, renaming or replacing according to the collision answer. */
  function commit(files: DroppedFile[], mode: "overwrite" | "keep-both") {
    if (mode === "overwrite") {
      onAddFiles?.(files);
      onSelect(files[files.length - 1]!.path);
      return;
    }
    // Freed paths accumulate across the batch, or two dropped files landing on
    // the same taken name would both be renamed to `-1`.
    const claimed = new Set(paths);
    const renamed = files.map((file) => {
      const path = uniquePath(file.path, (candidate) => claimed.has(candidate));
      claimed.add(path);
      return { ...file, path };
    });
    onAddFiles?.(renamed);
    onSelect(renamed[renamed.length - 1]!.path);
  }

  async function onDrop(event: DragEvent) {
    if (!canDrop) return;
    event.preventDefault();
    const targetDir = dropTargetPath
      ? dropTargetDir(dropTargetPath, !paths.includes(dropTargetPath))
      : "";
    // Read the DataTransfer synchronously — it is emptied as soon as this
    // handler returns, so anything read after the first await is gone.
    const entries = [...event.dataTransfer.items]
      .map((item) => (item.kind === "file" ? (item.webkitGetAsEntry() as DropEntryLike | null) : null))
      .filter((entry): entry is DropEntryLike => entry !== null);
    const plainFiles = entries.length ? [] : [...event.dataTransfer.files];
    endDrag();
    setDropNote(null);

    const result = entries.length
      // `expandZip` is injected rather than imported by `dropFiles.ts`: that module
      // stays dependency-free (and unit-testable with fakes), this one owns fflate.
      ? await collectDroppedEntries(entries, targetDir, { unzip })
      : await collectDroppedFiles(plainFiles, targetDir, { unzip });
    setDropNote(rejectionMessage(result));
    if (!result.files.length) return;
    // Files are about to appear; a shut section would hide the whole result.
    if (collapsed) onToggle();

    const clashes = result.files.map((f) => f.path).filter((p) => paths.includes(p));
    if (clashes.length) {
      setCollision({ files: result.files, clashes });
      return;
    }
    commit(result.files, "overwrite");
  }

  /** An archive is unpacked with the *drop's* rules (DEV-2531) — `dropZip.ts` takes
   *  them as an argument so it can stay free of sibling imports, and this is the
   *  only place that knows both halves. */
  const unzip = (bytes: Uint8Array) =>
    expandZip(bytes, { isTextFileName, isExcludedPath, maxFileBytes: MAX_DROP_FILE_BYTES });

  /** Drop-zone props, spread onto the section. Empty when dropping is not allowed
   *  — without a `dragover` preventDefault the browser navigates to the file. */
  const dropZone = canDrop
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!isFileDrag(event)) return;
          dragDepth.current += 1;
          setDropping(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          // Resolved from what is under the pointer *now*, on the section rather
          // than per row. Row-level `dragenter` handlers could set a target but
          // never unset it: moving from a row onto the header, or onto empty
          // space below the tree, left the last row as the target, so the hint
          // named a directory the pointer had left and the drop landed there.
          const next = targetPathFrom(event);
          setDropTargetPath((current) => (current === next ? current : next));
        },
        onDragLeave: () => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) endDrag();
        },
        onDrop,
      }
    : {};

  // Derived, not the raw state: `paths` is replaced wholesale on an example switch,
  // which would otherwise leave the dialog asking about a file that is no longer here.
  const confirming = pendingDelete && paths.includes(pendingDelete) ? pendingDelete : null;

  // …and the state itself has to go, not just its rendering. A path that leaves and
  // *comes back* — switch example away and back, or re-add the same name — would
  // otherwise re-open this dialog unprompted, asking about a delete nobody started.
  useEffect(() => {
    if (pendingDelete && !paths.includes(pendingDelete)) setPendingDelete(null);
  }, [paths, pendingDelete]);

  // An example switch replaces the file set wholesale, and a "skipped logo.png"
  // note from the previous workspace has nothing to do with the new one.
  //
  // Keyed on paths *disappearing*, not on `paths` changing at all: a successful
  // drop also changes `paths`, and a plain `[paths]` reset would wipe the note
  // that had just reported which of the dropped files were refused. Only an
  // example switch (or a delete) takes paths away.
  const seenPaths = useRef(paths);
  useEffect(() => {
    const removed = seenPaths.current.some((path) => !paths.includes(path));
    seenPaths.current = paths;
    if (removed) {
      setDropNote(null);
      setCollision(null);
    }
  }, [paths]);

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
    // The drop zone is the whole section, header included, so a drop still lands
    // when FILES is collapsed — `onDrop` expands it rather than swallowing the
    // files into a shut section. `data-dropping` drives the dashed target in the
    // app stylesheet: an inline background or border here would outrank it
    // (ADR-0026), which is what killed the demo-card hover before.
    <section
      style={section}
      aria-label="Files"
      data-dropping={dropping ? "true" : undefined}
      {...dropZone}
    >
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

      {/* Pinned over the section, not inserted into the file list: in the flow it
          added a row's worth of height the instant a drag entered, which shifted
          every row under a stationary pointer — retargeting the drop, or landing
          the pointer on the hint itself. `pointerEvents: none` keeps it out of the
          drag entirely, and the section's outline is what marks the target.
          Named for the e2e locator: a screenshot cannot tell a live drop target
          from a dead one. */}
      {dropping && (
        <p style={dropHint} data-testid="files-drop-hint">
          {`Drop into ${dropTargetDir(dropTargetPath, dropTargetPath !== null && !paths.includes(dropTargetPath)) || "the project root"}`}
        </p>
      )}

      {/* Outside `!collapsed`: a drop that expands the section renders its note in
          the same pass, and a collapsed section is where a wrong-file-type
          message is most needed (nothing else moved). */}
      {dropNote && (
        <p style={noteText} role="status">
          {dropNote}
        </p>
      )}

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
              <div
                key={node.path}
                className="hot-file-row"
                data-drop-target={dropping && dropTargetPath === node.path ? "true" : undefined}
                // Read by `targetPathFrom` on the section's dragover. The row sets
                // no handler of its own: only the section can tell that the
                // pointer has *left* a row.
                data-drop-path={canDrop ? node.path : undefined}
                style={row}
              >
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
                data-drop-target={dropping && dropTargetPath === node.path ? "true" : undefined}
                // A file row targets the file's own directory — "drop it next to
                // this" — resolved in `dropTargetDir`.
                data-drop-path={canDrop ? node.path : undefined}
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

      {/* A drop that would land on paths already in the workspace. Overwriting is
          offered but is not the default action, because the files it replaces may
          hold unsaved edits and nothing here can undo that. */}
      {collision && (
        <Dialog title="Some of these files already exist" onClose={() => setCollision(null)}>
          <p style={confirmBody}>
            {collision.clashes.length === 1
              ? `${collision.clashes[0]} is already in this workspace.`
              : `${collision.clashes.length} of the ${collision.files.length} dropped files are already in this workspace:`}
            {collision.clashes.length > 1 && (
              <>
                <br />
                <strong>{collision.clashes.slice(0, 5).join(", ")}</strong>
                {collision.clashes.length > 5 && ` and ${collision.clashes.length - 5} more`}
              </>
            )}
          </p>
          <div style={confirmFooter}>
            <button
              type="button"
              style={dangerButton}
              onClick={() => {
                commit(collision.files, "overwrite");
                setCollision(null);
              }}
            >
              Replace
            </button>
            {/* Focus lands on the non-destructive option, as in the delete confirm. */}
            <button
              type="button"
              data-autofocus
              style={ghostButton}
              onClick={() => {
                commit(collision.files, "keep-both");
                setCollision(null);
              }}
            >
              Keep both
            </button>
            <button type="button" style={ghostButton} onClick={() => setCollision(null)}>
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/**
 * The row under the pointer, as a workspace path — or null for the header, the
 * empty space below the tree, and anything else that is not a row.
 *
 * `closest` rather than the event target itself: a row is a `div` wrapping a
 * `button` wrapping an icon and a label, so the target is usually a descendant.
 */
function targetPathFrom(event: DragEvent): string | null {
  const node = event.target as Element | null;
  const row = node && typeof node.closest === "function" ? node.closest("[data-drop-path]") : null;
  return row?.getAttribute("data-drop-path") ?? null;
}

/**
 * Is this drag carrying files, rather than a text selection or an internal drag?
 *
 * Without the check, dragging a code selection out of the editor and across the
 * sidebar would light up the drop target and then drop nothing — `items` for a
 * text drag has `kind: "string"`. `types` is the only part of the DataTransfer
 * readable during `dragover` (the protected mode hides the data itself).
 */
function isFileDrag(event: DragEvent): boolean {
  return [...event.dataTransfer.types].includes("Files");
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
  // The positioning context for the drop hint overlay (DEV-2500). Nothing else in
  // this section is positioned, so this cannot disturb the sidebar's layout.
  position: "relative",
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
  ...theme.type.row,
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

/** The drop hint: an overlay over the section's lower edge while a file drag is
 *  over it. Absolute (never in the flow) and pointer-transparent — see the note
 *  at its render site. `surfaceRaised` rather than the accent tint, because it now
 *  floats over rows rather than sitting between them. */
const dropHint: CSSProperties = {
  position: "absolute",
  left: theme.space(3),
  right: theme.space(3),
  bottom: 4,
  margin: 0,
  padding: `${theme.space(1)} ${theme.space(2)}`,
  borderRadius: theme.radius.sm,
  border: `1px solid ${theme.color.accentBorder}`,
  background: theme.color.surfaceRaised,
  color: theme.color.accentText,
  fontFamily: theme.font.ui,
  ...theme.type.row,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  pointerEvents: "none",
};

/** What a drop refused. Sits under the header so it is visible collapsed too. */
const noteText: CSSProperties = {
  margin: `2px ${theme.space(3)}`,
  fontFamily: theme.font.ui,
  ...theme.type.row,
  color: theme.color.textMuted,
};

const confirmBody: CSSProperties = {
  margin: 0,
  ...theme.type.base,
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
  ...theme.type.base,
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
  padding: `${theme.space(1)} ${theme.space(2)}`,
  border: `1px solid ${theme.color.accent}`,
  borderRadius: theme.radius.sm,
  // Raised, not `surface`: this floats over the recessed sidebar, which is
  // #000000 in dark — `surface` (#070604) would be all but invisible against it.
  background: theme.color.surfaceRaised,
  color: theme.color.text,
};
