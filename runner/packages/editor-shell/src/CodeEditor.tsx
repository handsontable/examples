import { useCallback, useEffect, useMemo, useRef } from "react";
import CodeMirror, { type BasicSetupOptions, type EditorView, type ViewUpdate } from "@uiw/react-codemirror";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { vue } from "@codemirror/lang-vue";
import { useTheme } from "./useTheme.js";

function languageFor(path: string) {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".ts":
      return [javascript({ typescript: true })];
    case ".tsx":
      return [javascript({ typescript: true, jsx: true })];
    case ".js":
    case ".mjs":
    case ".cjs":
      return [javascript()];
    case ".jsx":
      return [javascript({ jsx: true })];
    case ".json":
      return [json()];
    case ".css":
      return [css()];
    case ".vue":
      return [vue()];
    case ".html":
    case ".astro": // close enough for highlighting; Astro has no dedicated CM6 mode
      return [html()];
    default:
      return [];
  }
}

/** Hoisted, not inlined at the JSX site: `basicSetup` is one of the props in
 *  `useCodeMirror`'s reconfigure dependency array, so an object literal there churns
 *  the editor's extensions on every render whatever the callbacks do (DEV-2568). */
const BASIC_SETUP = {
  lineNumbers: true,
  highlightActiveLine: true,
  foldGutter: true,
  autocompletion: true,
} as const satisfies BasicSetupOptions;

/** Caret position, 1-based, as the status bar shows it. */
export interface CursorPosition {
  line: number;
  col: number;
}

export interface CodeEditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  /** Live caret position, for the editor status bar. */
  onCursorChange?: (pos: CursorPosition) => void;
  /** Hands the underlying view to the shell once, at mount.
   *
   *  Needed since DEV-2169, which stops re-keying this component per file and keeps
   *  every open tab mounted instead. Two things then need the view directly: reading
   *  the live caret back when a tab is re-activated (the status bar no longer gets a
   *  fresh mount to reset it), and `requestMeasure()` on a pane returning from
   *  `visibility: hidden`. */
  onCreateEditor?: (view: EditorView) => void;
}

/** Thin CodeMirror wrapper: picks a language by file extension, and the GitHub
 *  Light/Dark theme so code colours match the documentation site (Figma `11:2535`). */
export function CodeEditor({
  path,
  value,
  onChange,
  readOnly,
  onCursorChange,
  onCreateEditor,
}: CodeEditorProps) {
  const extensions = useMemo(() => languageFor(path), [path]);
  const { mode } = useTheme();

  // Both handlers are insulated behind a ref, because `useCodeMirror` reconfigures the
  // whole extension set from an effect that lists `onChange` and `onUpdate` among its
  // dependencies (`useCodeMirror.js:158-165`) — `onUpdate` is literally installed as an
  // extension (`EditorView.updateListener.of(onUpdate)`). A handler with a fresh
  // identity each render therefore churns extensions on every render, in *every* open
  // tab, since T12 keeps them all mounted. Both of these end in setState in the parent.
  //
  // `onChange` is the one that bit us: reconfiguring mid-keystroke puts CodeMirror's
  // `DOMObserver` on the `applyDOMChange` → `defaultInsert()` path, which synthesises a
  // doc change, which calls `onChange` again — a nested-update loop until React throws
  // error 185 (DEV-2568 / Sentry DEMOS-1D). Hence the empty-dep callbacks reading refs:
  // the identities never change, whatever the caller passes.
  const cursorRef = useRef(onCursorChange);
  useEffect(() => {
    cursorRef.current = onCursorChange;
  }, [onCursorChange]);

  const changeRef = useRef(onChange);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);

  const handleChange = useCallback((value: string) => {
    changeRef.current(value);
  }, []);

  const handleUpdate = useCallback((vu: ViewUpdate) => {
    if (!vu.docChanged && !vu.selectionSet && !vu.focusChanged) return;
    // Derived here rather than taken from `onStatistics`, whose `line` is
    // `lineAt(selection.main.from)` — the wrong line for an upward multi-line
    // selection — and which carries no column at all.
    const { head } = vu.state.selection.main;
    const line = vu.state.doc.lineAt(head);
    cursorRef.current?.({ line: line.number, col: head - line.from + 1 });
  }, []);

  return (
    <CodeMirror
      value={value}
      height="100%"
      style={{ height: "100%", fontSize: 13 }}
      theme={mode === "dark" ? githubDark : githubLight}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      onChange={handleChange}
      onUpdate={handleUpdate}
      onCreateEditor={onCreateEditor}
      basicSetup={BASIC_SETUP}
    />
  );
}
