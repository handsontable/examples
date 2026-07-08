// Framework-agnostic editor shell. Binds only to the DemoRuntime interface
// (via props/callbacks) — no knowledge of Sandpack vs container engines.
export { theme } from "./theme.js";
export type { Theme } from "./theme.js";
export { EditorShell } from "./EditorShell.js";
export type { EditorShellProps } from "./EditorShell.js";
export { CodeEditor } from "./CodeEditor.js";
export { FileTree } from "./FileTree.js";
export { Toolbar } from "./Toolbar.js";
export { PreviewPane } from "./PreviewPane.js";
export type { PreviewStatus } from "./PreviewPane.js";
export { s as shellStyles } from "./styles.js";
export { default as logoUrl } from "./logo.svg";
