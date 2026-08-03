import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { EditorView } from "@uiw/react-codemirror";
import type { FilesMap } from "@handsontable/demo-runtime";
import { CodeEditor, type CursorPosition } from "./CodeEditor.js";
import { EditorBar } from "./EditorBar.js";
import { TAB_STRIP_ID, tabId, tabPanelId } from "./EditorTabs.js";
import { EditorStatusBar } from "./EditorStatusBar.js";
import { PreviewBar, type FrameworkChoice } from "./PreviewBar.js";
import { Sidebar } from "./Sidebar.js";
import { PreviewPane, type PreviewStatus } from "./PreviewPane.js";
import { PreviewStatusBar } from "./PreviewStatusBar.js";
import { SplitHandle, useSplitPane } from "./SplitPane.js";
import { TopBar } from "./TopBar.js";
import { s } from "./styles.js";

export interface EditorShellProps {
  frameworkLabel: string;
  /** Short project label for the preview status bar — `React (Vite, TS)` (`48:6706`).
   *  Distinct from `frameworkLabel`, which is the sidebar's title fallback: for a docs
   *  example that one is the long `"Columns ▸ … · Standard example · React (TS)"`
   *  breadcrumb string, which the bar has no room for. */
  frameworkName?: string;
  files: FilesMap;
  /** Entry path to open first (e.g. "/src/index.tsx"). Not guaranteed to exist in
   *  `files` — see `resolveEntry`. */
  entry: string;
  /** Changes when the app replaces the whole workspace, which is the only moment the
   *  open-tab set must be discarded rather than reconciled.
   *
   *  `files` alone cannot say this. It is replaced wholesale on every example switch,
   *  but it is *also* replaced on every keystroke and on a version re-pin, and two
   *  different workspaces can share path names (`/src/main.tsx` is most of them), so
   *  "which of these paths still exists" silently keeps a tab pointing at the previous
   *  example's file of the same name. The app passes its `mountGen` — the counter it
   *  already bumps in `loadWorkspace` and nowhere else. */
  workspaceKey?: string | number;
  /** Preview iframe binding — the app attaches its DemoRuntime here. */
  iframeRef: (el: HTMLIFrameElement | null) => void;
  status: PreviewStatus;
  errorMessage?: string | null;
  /** Live boot log for Tier-2 container sessions (shown while booting). */
  bootLog?: string;
  /** Tier 2: the boot overlay explains the tens-of-seconds wait and carries the log. */
  containerBoot?: boolean;
  /** A container rebuild is in flight after an edit (shows "Applying changes…"). */
  syncing?: boolean;
  /** A row-2 refresh is in flight — blanks the pane behind a spinner (`72:26445`). */
  refreshing?: boolean;

  version: string;
  versionOptions: string[];
  onVersionChange: (v: string) => void;
  versionWarning?: string | null;

  /** BOX INFO. `title` falls back to the example's display name for unsaved workspaces;
   *  `description` / `createdAt` only exist for a saved demo and their rows self-hide. */
  title?: string;
  description?: string;
  createdAt?: string;
  /** Opens the Edit info dialog from the BOX INFO pencil (`114:21684`). Named
   *  `onEditInfo`, not `onEdit`, because `onEdit` below is the file-content one. */
  onEditInfo?: () => void;
  /** Zips the live workspace — surfaced in the sidebar's FILES header, every mode.
   *  Same callback the top bar's `onDownload` takes; there is one zip path. */
  onDownloadAll?: () => void;
  // Sidebar visibility is not a prop: T2 owns it as `sidebarOpen` state here, toggled
  // from `EditorBar`. T3 deliberately did not add a second source of truth.

  /** Fired on every edit. The app updates its files map and calls runtime.writeFile. */
  onEdit: (path: string, contents: string) => void;
  /** File-tree CRUD (CodeSandbox-style). When omitted the tree is read-only-of-structure. */
  onAddFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onDeleteFile?: (path: string) => void;
  /** Persist the saved demo. Surfaced as the top bar's mode action in `edit`. */
  onSave: () => void;
  /** Open the share dialog. The app makes it mode-aware — in `play` it mints the
   *  demo first, which is what the retired `Embed` button did (ADR-0025). */
  onShare: () => void;
  onFork: () => void;
  /** Signed in *for this workspace*? Gates every authed affordance: the top bar's
   *  Fork/Save slot, the preview bar's share icon and its version pencil. Since T9
   *  this does not gate the top bar as a whole: `/share/:id` passes `false` here
   *  while still handing down `accountEmail`, so a signed-in visitor keeps their
   *  account menu on a read-only page instead of being offered "Sign in". */
  authed: boolean;
  /** Signed-in identity for the top bar's account menu (`114:21480`). */
  accountEmail?: string;
  onMyDemos?: () => void;
  onLogout?: () => void;
  /** "play" (playground -> Fork), "edit" (saved demo -> Save/Share), or
   *  "share" (read-only public playground). */
  mode?: "play" | "edit" | "share";
  /** A `play`-mode fork is in flight. Named for what it does: it drives the Fork
   *  button, and until T10 it was called `sharing` while nothing named share used it. */
  forking?: boolean;
  /** A share is in flight — only ever true in `play`, where the dialog needs a mint. */
  sharing?: boolean;
  saving?: boolean;
  shareUrl?: string | null;
  /** Workspace-level unsaved changes, for `Save •`. Deliberately kept alongside
   *  `dirtyPaths` rather than derived from it: the Edit info dialog marks the
   *  workspace dirty with no file path at all. */
  dirty?: boolean;
  /** Files edited since the last save — the per-tab unsaved-changes dot (ADR-0025 §3).
   *  One boolean could not do this job: it would dot every open tab on any edit. */
  dirtyPaths?: ReadonlySet<string>;

  // ---- chrome (T2) --------------------------------------------------------
  /** Centred top-bar pill: the app's example cascader, or the demo title. */
  examplePill?: ReactNode;
  /** Public demo URL for the row-2 address field, when the demo has one. */
  publicUrl?: string;
  /** Where the preview iframe is actually pointed (Tier 2 only). */
  previewUrl?: string;
  onRefreshPreview?: () => void;
  onMaximize?: () => void;
  onDownload?: () => void;
  onSignIn?: () => void;
  /** Framework variants of the current docs example. Empty for starters. */
  frameworks?: FrameworkChoice[];
  onFrameworkChange?: (key: string) => void;
  docsUrl?: string;
  repoUrl?: string;
  repoLabel?: string;
}

const CURSOR_ORIGIN: CursorPosition = { line: 1, col: 1 };

/** The first file to open, guarding the entry that does not exist.
 *
 *  `props.entry` comes from the catalog, and it is not always a key of `files`: a
 *  jsx-only docs example is served the `react-ts` entry `/src/main.tsx` while its
 *  file is emitted as `main.jsx` (DEV-2130). Falling through to the first path keeps
 *  the editor showing *something* rather than an empty pane over a full file tree.
 *  Used at mount, on reconciliation, and on a workspace switch — one rule, one place. */
function resolveEntry(files: FilesMap, entry: string, paths: string[]): string {
  return files[entry] !== undefined ? entry : (paths[0] ?? "");
}

/**
 * Framework-agnostic editor: chrome + file tree | code editor | live preview.
 * Binds only to props — it has no knowledge of Sandpack vs container.
 *
 * Layout follows the frames: one 72px top bar, then a body of three columns,
 * the editor and preview each carrying their own 36px bar (`72:15811` /
 * `72:15706`). There is no full-width second row.
 */
export function EditorShell(props: EditorShellProps) {
  const paths = useMemo(() => Object.keys(props.files), [props.files]);
  const initial = () => resolveEntry(props.files, props.entry, paths);
  // The open set, in tab order, and which of them is showing. Multi-file since
  // DEV-2169 (ADR-0025 §3) — `active` alone was ADR-0023's deferred single-file rule.
  const [openPaths, setOpenPaths] = useState<string[]>(() => {
    const first = initial();
    return first ? [first] : [];
  });
  const [active, setActive] = useState(initial);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const mode = props.mode ?? "play";
  // The editor/preview ratio: rendered onto the body grid, dragged from the
  // splitter that sits between the two columns (`SplitPane.tsx`).
  const split = useSplitPane(sidebarOpen);

  // Every open file keeps its own CodeMirror instance (DEV-2169), so switching a tab
  // no longer drops undo history or scroll position the way re-keying one editor did.
  // The views are held here for the two things that needs: reading the caret back on
  // activation, and re-measuring a pane that was hidden.
  const viewsRef = useRef(new Map<string, EditorView>());

  /** Open a file, or focus it if it is already open. What tree selection does. */
  const openFile = useCallback((path: string) => {
    if (!path) return;
    setOpenPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActive(path);
  }, []);

  /** Close a tab and activate a neighbour — right first, as editors do, so closing a
   *  run of tabs walks forward rather than bouncing back to the start.
   *
   *  Nothing is saved or discarded here. File contents live in the app's `files` map;
   *  this component holds view pointers only, so a closed tab's edits are still there
   *  when it is reopened from the tree (ADR-0025 §3 — and `e2e/editor-tabs.spec.ts`
   *  asserts it, which is the whole reason no confirmation dialog exists). */
  const closeFile = useCallback(
    (path: string) => {
      const i = openPaths.indexOf(path);
      if (i === -1) return;
      // Written flat rather than as nested state updaters: a `setActive` inside a
      // `setOpenPaths` callback is a side effect in a reducer, which StrictMode
      // double-invokes.
      const next = openPaths.filter((p) => p !== path);
      const nextActive = active === path ? (next[i] ?? next[i - 1] ?? "") : active;
      // Closing unmounts whatever the user was focused on, and focus then falls back to
      // `<body>` — so a keyboard user has to tab in from the top of the page again just
      // to close a second tab. Hand it to the neighbour instead.
      //
      // Gated on focus having been *in the strip*: a delete from the file tree also
      // lands here, and yanking focus out of the sidebar mid-interaction would be its
      // own bug. A mouse click on the ✕ does pass this test, which is what we want —
      // that click has already taken focus off whatever had it.
      if (document.activeElement?.closest('[role="tablist"]')) {
        pendingFocusRef.current = nextActive;
      }
      setOpenPaths(next);
      if (active === path) setActive(nextActive);
      viewsRef.current.delete(path);
    },
    [openPaths, active],
  );

  // Applied after the close has rendered — the element to focus is not the active tab
  // until then. A layout effect, not `useEffect`: focus has to land before paint, or
  // the ring flashes on the old position first.
  const pendingFocusRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) return;
    pendingFocusRef.current = null;
    // Nothing left to focus once the last tab goes, so the strip itself takes it
    // (`tabIndex={-1}`, reachable only this way). The user keeps their place in the
    // page and the next Tab carries on from the editor bar rather than from the top.
    document.getElementById(target ? tabId(target) : TAB_STRIP_ID)?.focus();
  }, [openPaths]);

  // Discard the open set when the *workspace* is replaced. Reconciling by path would
  // keep a tab open across an example switch whenever both examples happen to contain
  // the same filename — which, for `/src/main.tsx`, is nearly always. Skips the first
  // run: the initial state above already resolved the entry.
  const lastWorkspace = useRef(props.workspaceKey);
  useEffect(() => {
    if (lastWorkspace.current === props.workspaceKey) return;
    lastWorkspace.current = props.workspaceKey;
    // Drop the views with the tabs. Otherwise every example ever visited leaves a
    // destroyed `EditorView` in the map, and — the visible failure — if the new
    // workspace's entry resolves to the *same path*, the caret effect below reads the
    // stale view's selection and re-measures it before the fresh mount replaces it.
    viewsRef.current.clear();
    const first = resolveEntry(props.files, props.entry, paths);
    setOpenPaths(first ? [first] : []);
    setActive(first);
  }, [props.workspaceKey, props.files, props.entry, paths]);

  // Belt and braces for file-set changes that are *not* a workspace switch and did not
  // come through the CRUD wrappers below — a tab must never point at a file that is
  // gone. Both writes are guarded: `filter` returns a fresh array every run, so an
  // unconditional `setOpenPaths` with `openPaths` in the deps would loop forever.
  useEffect(() => {
    setOpenPaths((prev) => {
      const kept = prev.filter((p) => props.files[p] !== undefined);
      return kept.length === prev.length ? prev : kept;
    });
    if (active && props.files[active] === undefined) {
      setActive(resolveEntry(props.files, props.entry, paths));
    }
  }, [props.files, props.entry, active, paths]);

  const [cursor, setCursor] = useState<CursorPosition>(CURSOR_ORIGIN);

  // T4 reset the readout to Ln 1, Col 1 here, correctly: `CodeEditor` was re-keyed per
  // file, and a fresh mount starts at position 0 and emits no update event. With panes
  // kept alive that reset would *lie* — a tab returns with its caret where it was — so
  // the live selection is read back instead. `requestMeasure` is the belt-and-braces
  // half: the pane was `visibility: hidden`, which keeps its box (hence not
  // `display: none`), but a re-measure costs nothing and rules out stale gutters.
  useEffect(() => {
    const view = viewsRef.current.get(active);
    if (!view) {
      setCursor(CURSOR_ORIGIN);
      return;
    }
    const { head } = view.state.selection.main;
    const line = view.state.doc.lineAt(head);
    setCursor({ line: line.number, col: head - line.from + 1 });
    view.requestMeasure();
  }, [active, openPaths]);

  // Keep the activated tab visible when the strip has overflowed (see `EditorTabs`).
  useEffect(() => {
    if (!active) return;
    document
      .getElementById(tabId(active))
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  // ---- CRUD, intercepted on the way to the sidebar -------------------------
  // The tree's add / rename / delete change the *paths* the tabs point at, and the
  // reconciliation above can only drop a tab, never follow it. Wrapping the callbacks
  // is what makes a rename keep its tab: without this, renaming an open file closes it
  // and drops you back on the entry (which is what `active` alone did before DEV-2169).
  const { onAddFile, onRenameFile, onDeleteFile } = props;

  const addFile = useMemo(
    () =>
      onAddFile &&
      ((path: string) => {
        onAddFile(path);
        openFile(path);
      }),
    [onAddFile, openFile],
  );

  const renameFile = useMemo(
    () =>
      onRenameFile &&
      ((oldPath: string, newPath: string) => {
        onRenameFile(oldPath, newPath);
        setOpenPaths((prev) => (prev.includes(oldPath) ? prev.map((p) => (p === oldPath ? newPath : p)) : prev));
        setActive((cur) => (cur === oldPath ? newPath : cur));
        // The old view is keyed by the old path and is about to unmount; leaving it in
        // the map would keep a detached view alive and make the caret read-back on the
        // renamed tab return the stale one.
        viewsRef.current.delete(oldPath);
      }),
    [onRenameFile],
  );

  const deleteFile = useMemo(
    () =>
      onDeleteFile &&
      ((path: string) => {
        onDeleteFile(path);
        closeFile(path);
      }),
    [onDeleteFile, closeFile],
  );

  return (
    <div style={s.shell}>
      <TopBar
        examplePill={props.examplePill}
        onDownload={props.onDownload}
        onSignIn={props.onSignIn}
        accountEmail={props.accountEmail}
        onMyDemos={props.onMyDemos}
        onLogout={props.onLogout}
        // The mode action is resolved here, not in `TopBar`, and off `authed`
        // rather than off `accountEmail`. The two disagree on exactly one route:
        // a signed-in visitor to `/share/:id` has an `accountEmail` (so they keep
        // their account menu, T9) but `authed: false` (the demo is not theirs).
        // Keying the slot off the identity would hand them a Fork button.
        onFork={props.authed && mode === "play" ? props.onFork : undefined}
        forking={props.forking}
        onSave={props.authed && mode === "edit" ? props.onSave : undefined}
        saving={props.saving}
        dirty={props.dirty}
      />

      <div ref={split.bodyRef} style={{ ...s.body(sidebarOpen), ...split.bodyStyle }}>
        {/* Unmounted, not zero-width: a 0px track still paints the sidebar's right
            border, and `65:19433` has nothing at the left edge. */}
        {sidebarOpen && (
          <Sidebar
            title={props.title ?? props.frameworkLabel}
            description={props.description}
            createdAt={props.createdAt}
            onEdit={props.onEditInfo}
            packageJson={props.files["/package.json"]}
            paths={paths}
            active={active}
            // Selecting in the tree opens a tab, or focuses the one already open.
            onSelect={openFile}
            onDownloadAll={props.onDownloadAll}
            editable={!!props.onAddFile}
            // The wrapped forms, not the raw props: they keep the tab strip in step
            // with what the tree just did to the file set.
            onAddFile={addFile}
            onRenameFile={renameFile}
            onDeleteFile={deleteFile}
          />
        )}

        <div style={s.column()}>
          <EditorBar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((o) => !o)}
            paths={openPaths}
            active={active}
            onSelect={openFile}
            onClose={closeFile}
            dirtyPaths={props.dirtyPaths}
          />
          <div style={s.editorBody}>
            {/* One mounted editor per open tab, only the active one visible. Hiding
                rather than unmounting is what preserves undo history and scroll
                across a tab switch — see `s.editorPane` for why it is `visibility`
                and why both states are absolutely positioned. */}
            {openPaths.map((path) => (
              <div
                // Keyed by workspace *and* path, not path alone. Two workspaces
                // routinely share an entry (`React (Vite, TS)` and `MUI + React` are
                // both `/src/index.tsx`), and on a bare `path` key React reuses the
                // previous workspace's CodeEditor for it. The new file's contents do
                // land in the doc, so it looks right — but the old undo stack rides
                // along, and one Cmd+Z rewrites the whole file back to the *previous
                // example's* source, through `onEdit` and on into the preview.
                //
                // It also silently disables this pane's caret read-back: without a
                // remount `onCreateEditor` never fires again, so the view stays absent
                // from `viewsRef` (which the workspace switch just cleared) for the
                // rest of the session.
                //
                // Within a workspace the key is stable, which is what keeps per-tab
                // undo — the whole point of mounting every tab — working.
                key={`${props.workspaceKey ?? ""} ${path}`}
                id={tabPanelId(path)}
                role="tabpanel"
                aria-labelledby={tabId(path)}
                // How the e2e specs find the visible editor. They cannot key off the
                // inline style — `[style*="hidden"]` would start matching every pane
                // the day this object grows an `overflow: hidden`, and the failure
                // would surface as a timeout nowhere near the cause.
                data-pane-active={path === active ? "true" : undefined}
                style={s.editorPane(path === active)}
              >
                <CodeEditor
                  path={path}
                  value={props.files[path] ?? ""}
                  // Closes over `path`, never `active`. With one re-keyed editor the
                  // two were interchangeable; with every tab mounted, `active` would
                  // write each pane's edits into whichever file is showing.
                  onChange={(v) => props.onEdit(path, v)}
                  // Only the visible pane drives the status bar. A hidden one still
                  // emits on focus changes, and would overwrite the readout.
                  onCursorChange={path === active ? setCursor : undefined}
                  onCreateEditor={(view) => viewsRef.current.set(path, view)}
                />
              </div>
            ))}
            {/* Undesigned: no frame draws an editor with nothing open (ADR-0023
                rule 1). Closing the last tab is allowed rather than blocked — the
                file tree is right there, and a ✕ that silently refuses is worse. */}
            {openPaths.length === 0 && (
              <p style={s.editorEmpty}>No file open. Pick one from the files sidebar.</p>
            )}
          </div>
          {/* Kept in the empty state too: three of its four segments are static
              labels, and dropping the band would shift the preview's status bar out
              of alignment with it. */}
          <EditorStatusBar line={cursor.line} col={cursor.col} />
        </div>

        <SplitHandle split={split} />

        <div style={s.column()}>
          <PreviewBar
            publicUrl={props.publicUrl}
            previewUrl={props.previewUrl}
            onRefresh={props.onRefreshPreview}
            onMaximize={props.onMaximize}
            version={props.version}
            versionOptions={props.versionOptions}
            onVersionChange={props.onVersionChange}
            versionLocked={mode === "share"}
            versionWarning={props.versionWarning}
            // Both signed-in only, and both excluded from `share` — where the
            // version is pinned and the demo is someone else's to share.
            versionEditable={props.authed && mode !== "share"}
            frameworks={props.frameworks}
            onFrameworkChange={props.onFrameworkChange}
            onShare={props.authed && mode !== "share" ? props.onShare : undefined}
            sharing={props.sharing}
            docsUrl={props.docsUrl}
            repoUrl={props.repoUrl}
            repoLabel={props.repoLabel}
          />

          <PreviewPane
            iframeRef={props.iframeRef}
            status={props.status}
            errorMessage={props.errorMessage}
            bootLog={props.bootLog}
            containerBoot={props.containerBoot}
            syncing={props.syncing}
            refreshing={props.refreshing}
          />

          {/* Outside `PreviewPane`, deliberately: its overlays are `inset: 0`, so a bar
              inside that section would be painted over by every one of them. Here it
              also lands in the same 28px band as `EditorStatusBar` above, which is how
              the frames draw the two (`48:6701` / `48:6740`). */}
          <PreviewStatusBar
            status={props.status}
            frameworkName={props.frameworkName}
            version={props.version}
          />
        </div>
      </div>
    </div>
  );
}
