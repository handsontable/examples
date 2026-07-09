import { useEffect, useMemo, useState } from "react";
import type { FilesMap } from "@handsontable/demo-runtime";
import { CodeEditor } from "./CodeEditor.js";
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
          {active && (
            <CodeEditor
              key={active}
              path={active}
              value={props.files[active] ?? ""}
              onChange={(v) => props.onEdit(active, v)}
            />
          )}
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
