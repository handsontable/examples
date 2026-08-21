import { useCallback, useEffect, useMemo, useRef } from "react";
import CodeMirror, { EditorView, Prec, type BasicSetupOptions, type ViewUpdate } from "@uiw/react-codemirror";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { vue } from "@codemirror/lang-vue";
import { theme } from "./theme.js";
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
  // The designed gutter (48:6738) is line numbers alone — the fold column made it a
  // two-column strip the design does not have. Folding itself survives: the default
  // keymap's fold bindings don't ride on the gutter.
  foldGutter: false,
  autocompletion: true,
} as const satisfies BasicSetupOptions;

/** The editor pane as the design draws it (Figma 48:6719 light / 31:6597 dark):
 *  Fira Code 12/20, a 16px inset all around, and a chromeless gutter — no fill, no
 *  divider, numbers right-aligned at 40% of the ink colour. Split from `GUTTER_INK`
 *  below because everything here is mode-invariant or var()-resolved. `Prec.high`
 *  is not decoration: the `theme` prop outranks plain `extensions` entries, so
 *  without it githubDark's #0d1117 background wins over `&`'s (measured) — the
 *  design's dark editor is `editorBg` (#19191c). */
const CHROME = {
  "&": { fontSize: "12px", backgroundColor: "var(--hot-color-editor-bg)" },
  ".cm-scroller": { fontFamily: theme.font.mono, lineHeight: "20px" },
  ".cm-content": { padding: "16px 0" },
  ".cm-line": { padding: "0 16px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", paddingLeft: "16px" },
  // Default is "0 3px 0 5px", which would break the designed 16px number→code gap.
  ".cm-lineNumbers .cm-gutterElement": { padding: "0" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },

  // The Mod-F search panel (@codemirror/search's stock DOM), which otherwise
  // ships CodeMirror's UA-grey look: gradient buttons, unstyled fields, a bare ×.
  // Restated in the shell's own idiom — `surfaceRaised` band over a hairline,
  // controls as `surface` + `controlBorder` + 4px radius at 12/20, the same
  // recipe as `.hot-btn-ghost` and the panel selects. All var()-resolved, so one
  // block serves both modes. Flex + gap replaces the markup's whitespace-node
  // spacing, which is what put every control on its own arbitrary offset.
  ".cm-panels": { backgroundColor: "var(--hot-color-surface-raised)", color: "var(--hot-color-text)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--hot-color-control-border)" },
  ".cm-panel.cm-search": {
    display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px",
    padding: "8px 16px", paddingRight: "40px",
    fontFamily: "var(--hot-font-ui)", fontSize: "12px", lineHeight: "20px",
  },
  // The markup separates its find and replace rows with a lone <br>; as a flex
  // item that renders as nothing and the two rows shuffle together at narrow
  // pane widths. A 100% basis turns it back into a row break.
  ".cm-panel.cm-search br": { flexBasis: "100%", height: "0" },
  ".cm-panel.cm-search .cm-textfield": {
    font: "inherit", flex: "1 1 128px", width: "auto", margin: "0", padding: "4px 8px",
    background: "var(--hot-color-surface)", color: "var(--hot-color-text)",
    border: "1px solid var(--hot-color-control-border)", borderRadius: "4px",
  },
  ".cm-panel.cm-search .cm-textfield:focus": {
    outline: "none", borderColor: "var(--hot-color-accent)",
  },
  ".cm-panel.cm-search .cm-button": {
    font: "inherit", margin: "0", padding: "4px 8px", cursor: "pointer",
    // The stock look is a grey gradient; `none` alone leaves it showing.
    backgroundImage: "none",
    background: "var(--hot-color-surface)", color: "var(--hot-color-text)",
    border: "1px solid var(--hot-color-control-border)", borderRadius: "4px",
    textTransform: "capitalize",
  },
  ".cm-panel.cm-search .cm-button:active": { background: "var(--hot-color-surface-muted)" },
  ".cm-panel.cm-search label": {
    display: "inline-flex", alignItems: "center", gap: "4px",
    fontSize: "12px", textTransform: "capitalize", cursor: "pointer",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    margin: "0", accentColor: "var(--hot-color-accent)",
  },
  ".cm-panel.cm-search button[name=close]": {
    position: "absolute", top: "8px", right: "8px",
    width: "24px", height: "24px", padding: "0",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: "transparent", border: "none", borderRadius: "4px",
    color: "var(--hot-color-text-muted)", fontSize: "16px", cursor: "pointer",
  },
  ".cm-panel.cm-search button[name=close]:hover": {
    background: "var(--hot-color-hover)", color: "var(--hot-color-text)",
  },
} as const;
/** 40% of black/white per mode — the one part of the chrome no shell token or
 *  var() covers, hence two theme instances instead of one. */
const chromeLight = Prec.high(EditorView.theme({ ...CHROME, ".cm-lineNumbers": { color: "rgba(0, 0, 0, 0.4)" } }));
const chromeDark = Prec.high(EditorView.theme({ ...CHROME, ".cm-lineNumbers": { color: "rgba(255, 255, 255, 0.4)" } }));

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
  const { mode } = useTheme();
  const extensions = useMemo(
    () => [...languageFor(path), mode === "dark" ? chromeDark : chromeLight],
    [path, mode],
  );

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
      style={{ height: "100%" }}
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
