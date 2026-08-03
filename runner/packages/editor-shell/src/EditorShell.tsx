import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { FilesMap } from "@handsontable/demo-runtime";
import { CodeEditor, type CursorPosition } from "./CodeEditor.js";
import { EditorBar } from "./EditorBar.js";
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
  /** Entry path to open first (e.g. "/src/index.tsx"). */
  entry: string;
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
  dirty?: boolean;

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
  const [active, setActive] = useState(() =>
    props.files[props.entry] !== undefined ? props.entry : (paths[0] ?? ""),
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const mode = props.mode ?? "play";
  // The editor/preview ratio: rendered onto the body grid, dragged from the
  // splitter that sits between the two columns (`SplitPane.tsx`).
  const split = useSplitPane(sidebarOpen);

  // Keep the active file valid if the file set changes (e.g. example switch).
  useEffect(() => {
    if (props.files[active] === undefined) {
      setActive(props.files[props.entry] !== undefined ? props.entry : (paths[0] ?? ""));
    }
  }, [props.files, props.entry, active, paths]);

  // A fresh CodeMirror doc starts its selection at position 0, so Ln 1, Col 1 is
  // correct at mount and no `onCreateEditor` read is needed. `CodeEditor` is
  // re-keyed per file (ADR-0016) and a mount emits no update event, so the readout
  // has to be reset here when the active file changes.
  const [cursor, setCursor] = useState<CursorPosition>(CURSOR_ORIGIN);
  useEffect(() => {
    setCursor(CURSOR_ORIGIN);
  }, [active]);

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
            onSelect={setActive}
            onDownloadAll={props.onDownloadAll}
            editable={!!props.onAddFile}
            onAddFile={props.onAddFile}
            onRenameFile={props.onRenameFile}
            onDeleteFile={props.onDeleteFile}
          />
        )}

        <div style={s.column()}>
          {/* One open file at a time — the tab strip mirrors `active` (ADR-0023). */}
          <EditorBar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((o) => !o)}
            paths={active ? [active] : []}
            active={active}
            onSelect={setActive}
          />
          <div style={s.editorBody}>
            {active && (
              <CodeEditor
                key={active}
                path={active}
                value={props.files[active] ?? ""}
                onChange={(v) => props.onEdit(active, v)}
                onCursorChange={setCursor}
              />
            )}
          </div>
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
