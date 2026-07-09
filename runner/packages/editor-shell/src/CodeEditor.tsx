import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { vue } from "@codemirror/lang-vue";

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

export interface CodeEditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

/** Thin CodeMirror wrapper: picks a language by file extension, dark theme. */
export function CodeEditor({ path, value, onChange, readOnly }: CodeEditorProps) {
  const extensions = useMemo(() => languageFor(path), [path]);
  return (
    <CodeMirror
      value={value}
      height="100%"
      style={{ height: "100%", fontSize: 13 }}
      theme={oneDark}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      onChange={onChange}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        foldGutter: true,
        autocompletion: true,
      }}
    />
  );
}
