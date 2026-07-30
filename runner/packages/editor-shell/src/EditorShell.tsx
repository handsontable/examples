import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { FilesMap } from "@handsontable/demo-runtime";
import { AuthedActionBar } from "./AuthedActionBar.js";
import { CodeEditor } from "./CodeEditor.js";
import { EditorBar } from "./EditorBar.js";
import { FileTree } from "./FileTree.js";
import { PreviewBar, type FrameworkChoice } from "./PreviewBar.js";
import { PreviewPane, type PreviewStatus } from "./PreviewPane.js";
import { TopBar } from "./TopBar.js";
import { s } from "./styles.js";

export interface EditorShellProps {
  frameworkLabel: string;
  files: FilesMap;
  /** Entry path to open first (e.g. "/src/index.tsx"). */
  entry: string;
  /** Bumped by the app whenever the whole file set is replaced (example switch,
   *  fork/edit load). Reopens a closed tab; a replaced workspace is a new
   *  document, so the user's "close this tab" no longer applies to it. */
  workspaceGen?: number;
  /** Preview iframe binding — the app attaches its DemoRuntime here. */
  iframeRef: (el: HTMLIFrameElement | null) => void;
  status: PreviewStatus;
  errorMessage?: string | null;
  /** Live boot log for Tier-2 container sessions (shown while booting). */
  bootLog?: string;
  /** A container rebuild is in flight after an edit (shows "Applying changes…"). */
  syncing?: boolean;

  version: string;
  versionOptions: string[];
  onVersionChange: (v: string) => void;
  versionWarning?: string | null;

  /** Fired on every edit. The app updates its files map and calls runtime.writeFile. */
  onEdit: (path: string, contents: string) => void;
  /** File-tree CRUD (CodeSandbox-style). When omitted the tree is read-only-of-structure. */
  onAddFile?: (path: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onDeleteFile?: (path: string) => void;
  onSave: () => void;
  onShare: () => void;
  onFork: () => void;
  /** Create an embeddable (docs-only) version from the current playground code. */
  onEmbed?: () => void;
  embedding?: boolean;
  /** Signed in? Gates the authed action bar and the Sign in button. */
  authed: boolean;
  /** "play" (playground -> Fork), "edit" (saved demo -> Save/Share), or
   *  "share" (read-only public playground). */
  mode?: "play" | "edit" | "share";
  sharing?: boolean;
  saving?: boolean;
  shareUrl?: string | null;
  dirty?: boolean;

  // ---- chrome (T2) --------------------------------------------------------
  /** Centred top-bar pill: the app's example cascader, or the demo title. */
  examplePill?: ReactNode;
  /** App-owned signed-in controls appended to the authed action bar. */
  authedExtras?: ReactNode;
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
  const [closed, setClosed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const mode = props.mode ?? "play";

  // Keep the active file valid if the file set changes (rename, delete, example
  // switch). A deliberately closed tab stays closed — but only until the whole
  // workspace is replaced, which `workspaceGen` announces: two examples can
  // share an entry path, so a valid `active` is not proof nothing changed.
  useEffect(() => {
    if (props.files[active] === undefined) {
      setActive(props.files[props.entry] !== undefined ? props.entry : (paths[0] ?? ""));
    }
  }, [props.files, props.entry, active, paths]);

  useEffect(() => {
    setClosed(false);
  }, [props.workspaceGen]);

  function select(path: string) {
    setClosed(false);
    setActive(path);
  }

  return (
    <div style={s.shell}>
      <TopBar
        examplePill={props.examplePill}
        onDownload={props.onDownload}
        onSignIn={props.onSignIn}
        authed={props.authed}
      />

      <div style={s.body(sidebarOpen)}>
        {sidebarOpen && (
          <FileTree
            paths={paths}
            active={closed ? "" : active}
            onSelect={select}
            editable={!!props.onAddFile}
            onAddFile={props.onAddFile}
            onRenameFile={props.onRenameFile}
            onDeleteFile={props.onDeleteFile}
          />
        )}

        <div style={s.column(true)}>
          <EditorBar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((o) => !o)}
            active={closed ? "" : active}
            onClose={() => setClosed(true)}
          />
          <div style={s.editorPane}>
            {!closed && active && (
              <CodeEditor
                key={active}
                path={active}
                value={props.files[active] ?? ""}
                onChange={(v) => props.onEdit(active, v)}
              />
            )}
          </div>
        </div>

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
            frameworks={props.frameworks}
            onFrameworkChange={props.onFrameworkChange}
            docsUrl={props.docsUrl}
            repoUrl={props.repoUrl}
            repoLabel={props.repoLabel}
          />

          {props.authed && (
            <AuthedActionBar
              mode={mode}
              onSave={props.onSave}
              onShare={props.onShare}
              onFork={props.onFork}
              onEmbed={props.onEmbed}
              onVersionChange={props.onVersionChange}
              embedding={props.embedding}
              sharing={props.sharing}
              saving={props.saving}
              dirty={props.dirty}
              extras={props.authedExtras}
            />
          )}

          <PreviewPane
            iframeRef={props.iframeRef}
            status={props.status}
            errorMessage={props.errorMessage}
            bootLog={props.bootLog}
            syncing={props.syncing}
          />
        </div>
      </div>
    </div>
  );
}
