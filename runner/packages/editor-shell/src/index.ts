// Framework-agnostic editor shell. Binds only to the DemoRuntime interface
// (via props/callbacks) — no knowledge of Sandpack vs container engines.
export { theme, THEME_CSS, THEME_ATTR, THEME_STORAGE_KEY } from "./theme.js";
export type { Theme, ThemeMode } from "./theme.js";
export { ThemeProvider, useTheme } from "./useTheme.js";
export type { ThemeContextValue } from "./useTheme.js";
export { ThemeToggle } from "./ThemeToggle.js";
export { EditorShell } from "./EditorShell.js";
export type { EditorShellProps } from "./EditorShell.js";
export { CodeEditor } from "./CodeEditor.js";
export type { CodeEditorProps, CursorPosition } from "./CodeEditor.js";
export { EditorTabs } from "./EditorTabs.js";
export type { EditorTabsProps } from "./EditorTabs.js";
export { EditorStatusBar } from "./EditorStatusBar.js";
export type { EditorStatusBarProps } from "./EditorStatusBar.js";
export { FileTree } from "./FileTree.js";
export { PreviewPane } from "./PreviewPane.js";
export type { PreviewStatus } from "./PreviewPane.js";
// Chrome (T2). `Toolbar` is gone — its contents are split across these.
export { TopBar } from "./TopBar.js";
export { EditorBar } from "./EditorBar.js";
export { PreviewBar } from "./PreviewBar.js";
export type { FrameworkChoice } from "./PreviewBar.js";
export { AuthedActionBar } from "./AuthedActionBar.js";
export { MenuButton } from "./MenuButton.js";
export type { MenuOption } from "./MenuButton.js";
export { s as shellStyles, SIDEBAR_WIDTH } from "./styles.js";
export { logoUrl, useLogoUrl } from "./useLogoUrl.js";
// Icons — tabler for UI, seti-ui for file types. See src/icons/index.ts.
export * from "./icons/index.js";
