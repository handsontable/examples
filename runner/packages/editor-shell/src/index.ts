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
export { PreviewPane } from "./PreviewPane.js";
export type { PreviewStatus } from "./PreviewPane.js";
// Preview chrome (T5). `PreviewStatusBar` is exported on its own because T8's
// `?mode=full` view is "top bar + URL bar + preview + bottom status bar", without the
// rest of the shell. `Spinner` is exported because the app's splash needs it too.
export { PreviewStatusBar } from "./PreviewStatusBar.js";
export type { PreviewStatusBarProps } from "./PreviewStatusBar.js";
export { Spinner } from "./Spinner.js";
export type { SpinnerProps } from "./Spinner.js";
// Left sidebar (T3). `FileTree` is now the FILES section of `Sidebar`, not the column.
export { Sidebar } from "./Sidebar.js";
export type { SidebarProps } from "./Sidebar.js";
export { BoxInfo, formatCreated } from "./BoxInfo.js";
export type { BoxInfoProps } from "./BoxInfo.js";
export { Dependencies, parseDependencies } from "./Dependencies.js";
export type { DependenciesProps, Dependency } from "./Dependencies.js";
export { FileTree, buildFileTree } from "./FileTree.js";
export type { FileTreeProps } from "./FileTree.js";
export { SectionHeader, headerLabel } from "./SectionHeader.js";
export type { SectionHeaderProps } from "./SectionHeader.js";
// Chrome (T2). `Toolbar` is gone — its contents are split across these.
export { TopBar } from "./TopBar.js";
export { EditorBar } from "./EditorBar.js";
export { PreviewBar } from "./PreviewBar.js";
export type { FrameworkChoice } from "./PreviewBar.js";
export { PreviewUrlField } from "./PreviewUrlField.js";
export type { PreviewUrlFieldProps } from "./PreviewUrlField.js";
// Full mode (T8) — `?mode=full` is top bar + this bar + preview + status bar.
export { FullBar } from "./FullBar.js";
export type { FullBarProps } from "./FullBar.js";
export { MenuButton } from "./MenuButton.js";
export type { MenuOption } from "./MenuButton.js";
// Undesigned-surface work (T9). `Dialog` is the primitive the two After Login
// dialog frames share; `AccountMenu` is the avatar popover from `114:21480`.
export { Dialog } from "./Dialog.js";
export type { DialogProps } from "./Dialog.js";
export { AccountMenu } from "./AccountMenu.js";
export type { AccountMenuProps } from "./AccountMenu.js";
export { s as shellStyles, SIDEBAR_WIDTH } from "./styles.js";
export { logoUrl, markUrl, useLogoUrl } from "./useLogoUrl.js";
// Icons — tabler for UI, seti-ui for file types. See src/icons/index.ts.
export * from "./icons/index.js";
