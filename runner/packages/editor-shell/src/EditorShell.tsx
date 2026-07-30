import { useEffect, useMemo, useState } from "react";
import type { FilesMap } from "@handsontable/demo-runtime";
import { CodeEditor, type CursorPosition } from "./CodeEditor.js";
import { EditorTabs } from "./EditorTabs.js";
import { EditorStatusBar } from "./EditorStatusBar.js";
import { FileTree } from "./FileTree.js";
import { Toolbar } from "./Toolbar.js";
import { PreviewPane, type PreviewStatus } from "./PreviewPane.js";
import { s } from "./styles.js";

export interface EditorShellProps {
  frameworkLabel: string;
  files: FilesMap;
  /** Entry path to open first (e.g. "/src/index.tsx"). */
  entry: string;
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
  /** Signed in? Gates Save/Share/custom-version vs a Fork call-to-action. */
  authed: boolean;
  /** "play" (playground -> Fork), "edit" (saved demo -> Save/Share), or
   *  "share" (read-only public playground). */
  mode?: "play" | "edit" | "share";
  sharing?: boolean;
  saving?: boolean;
  shareUrl?: string | null;
  dirty?: boolean;
}

const CURSOR_ORIGIN: CursorPosition = { line: 1, col: 1 };

/**
 * Framework-agnostic editor: file tree | code editor | live preview + toolbar.
 * Binds only to props — it has no knowledge of Sandpack vs container.
 */
export function EditorShell(props: EditorShellProps) {
  const paths = useMemo(() => Object.keys(props.files), [props.files]);
  const [active, setActive] = useState(() =>
    props.files[props.entry] !== undefined ? props.entry : (paths[0] ?? ""),
  );

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
      <Toolbar
        frameworkLabel={props.frameworkLabel}
        version={props.version}
        versionOptions={props.versionOptions}
        onVersionChange={props.onVersionChange}
        onSave={props.onSave}
        onShare={props.onShare}
        onFork={props.onFork}
        onEmbed={props.onEmbed}
        embedding={props.embedding}
        authed={props.authed}
        mode={props.mode}
        sharing={props.sharing}
        saving={props.saving}
        shareUrl={props.shareUrl}
        dirty={props.dirty}
      />
      <div style={s.body}>
        <FileTree
          paths={paths}
          active={active}
          onSelect={setActive}
          editable={!!props.onAddFile}
          onAddFile={props.onAddFile}
          onRenameFile={props.onRenameFile}
          onDeleteFile={props.onDeleteFile}
        />
        <div style={s.editorPane}>
          {/* One open file at a time — the tab strip mirrors `active` (ADR-0023). */}
          <EditorTabs paths={active ? [active] : []} active={active} onSelect={setActive} />
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
        <PreviewPane
          iframeRef={props.iframeRef}
          status={props.status}
          errorMessage={props.errorMessage}
          bootLog={props.bootLog}
          syncing={props.syncing}
        />
      </div>
    </div>
  );
}
