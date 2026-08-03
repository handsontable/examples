// Shared inline-style objects derived from the branding theme. Kept in one place
// so the shell reads as one intentional system rather than ad-hoc CSS.
//
// This stays a frozen module-level object even though the shell is now two-mode:
// every `t.color.*` is a `var(--hot-…)` reference, so the browser re-resolves it
// when the root attribute flips. Nothing here needs to be recomputed (ADR-0022).
import type { CSSProperties } from "react";
import { theme } from "./theme.js";

const t = theme;

/** Sidebar column, per `48:6748`. */
export const SIDEBAR_WIDTH = 240;

/** The preview's share of the body, as a CSS length. Read from a custom property
 *  so a drag can move the seam by writing one property on the body node, without
 *  a React render per pointermove (`SplitPane.tsx`). */
export const SPLIT_VAR = "--hot-split";

/** How far the splitter's pointer target overhangs its 1px track, each side.
 *  `SplitPane` re-uses it to decide whether a released pointer is still on the
 *  handle, so the hit box has one definition. */
export const SPLITTER_HIT_SLOP = 4;

export const s = {
  shell: {
    display: "grid",
    gridTemplateRows: "auto 1fr",
    height: "100%",
    minHeight: 0,
    background: t.color.surface,
    color: t.color.text,
    fontFamily: t.font.ui,
  } satisfies CSSProperties,

  /**
   * The preview holds a share of the *whole body*, sidebar track included, and the
   * *editor* absorbs the sidebar — measured, not assumed: the preview column starts
   * at x=864 of 1728 in both `72:15697` (sidebar collapsed) and `48:6560` (sidebar
   * open at 240). `1fr 1fr` would put the boundary at 984 with the sidebar open.
   * T6 made that share draggable but kept it body-relative, so toggling the sidebar
   * still does not move the seam.
   *
   * The collapsed form drops the track entirely rather than sizing it to 0: the
   * sidebar carries a right border, which a zero-width track would still paint as
   * a seam, and `65:19433` has nothing at the left edge.
   *
   * The 1px track between the two panes is the splitter, which paints the
   * editor/preview boundary the editor column used to carry as a `borderRight`.
   */
  body: (sidebarOpen: boolean): CSSProperties => ({
    display: "grid",
    gridTemplateColumns: `${sidebarOpen ? `${SIDEBAR_WIDTH}px ` : ""}minmax(0, 1fr) 1px var(${SPLIT_VAR}, 50%)`,
    minHeight: 0,
    height: "100%",
  }),

  /** Row 1 (`72:15840`): 72px tall, the most-raised chrome.
   *  `zIndex` is load-bearing: the centred pill is positioned with a
   *  `transform`, which makes it a stacking context, so a popover opened inside
   *  it (the example cascader) can only stack against the rest of the page
   *  through this bar. Without it the preview pane — `position: relative`, later
   *  in the DOM — paints over the popover. */
  topBar: {
    position: "relative",
    zIndex: 30,
    display: "flex",
    alignItems: "center",
    gap: t.space(2),
    height: 72,
    padding: `0 ${t.space(5)}`,
    boxSizing: "border-box",
    borderBottom: `1px solid ${t.color.border}`,
    background: t.color.surfaceRaised,
    fontFamily: t.font.ui,
    color: t.color.text,
  } satisfies CSSProperties,

  /**
   * The centred example pill. Two forms in the design: a fixed 480px cascader
   * trigger with a search icon (`72:15859`, play mode) and a shrink-to-fit demo
   * title (`48:6580`, edit/share).
   */
  examplePill: (fixed: boolean): CSSProperties => ({
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: t.space(2),
    height: 36,
    width: fixed ? 480 : "auto",
    maxWidth: "min(480px, 40vw)",
    padding: `0 ${t.space(2)}`,
    boxSizing: "border-box",
    borderRadius: t.radius.md,
    border: `1px solid ${t.color.border}`,
    background: t.color.surface,
    color: t.color.text,
    fontFamily: t.font.ui,
    fontSize: 13,
  }),

  /** Row 2 (`72:15811` / `72:15706`): 36px, one bar per body column. */
  bar: {
    display: "flex",
    alignItems: "center",
    height: 36,
    flex: "0 0 auto",
    borderBottom: `1px solid ${t.color.border}`,
    background: t.color.surface,
    fontFamily: t.font.ui,
    fontSize: 13,
    color: t.color.text,
  } satisfies CSSProperties,

  /** The 36×36 square every row-2 control is drawn in. */
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    flex: "0 0 auto",
    padding: 0,
    border: "none",
    background: "transparent",
    borderRadius: t.radius.md,
    color: t.color.text,
    cursor: "pointer",
    textDecoration: "none",
  } satisfies CSSProperties,

  /**
   * The editor column's own row-2 bar. Same 36px as `bar`, but it takes the tab
   * strip's recessed background and inset hairline rather than `bar`'s `surface`
   * + bottom border, so the sidebar toggle and `EditorTabs` read as one row with
   * no seam. `surface` is unusable here: it is `#ffffff` in light, identical to
   * an active tab (T4's measurement, `EditorTabs.tsx`).
   */
  editorBar: {
    display: "flex",
    alignItems: "stretch",
    height: 36,
    flex: "0 0 auto",
    background: t.color.surfaceSunken,
    boxShadow: `inset 0 -1px 0 ${t.color.border}`,
    fontFamily: t.font.ui,
    fontSize: 13,
    color: t.color.text,
  } satisfies CSSProperties,

  /** Read-only preview address (`72:15710`). */
  urlField: {
    display: "flex",
    alignItems: "center",
    gap: t.space(2),
    flex: 1,
    minWidth: 0,
    height: 20,
    padding: `0 ${t.space(2)}`,
    border: "none",
    background: "transparent",
    color: t.color.textMuted,
    fontFamily: t.font.ui,
    fontSize: 13,
    textAlign: "left",
    cursor: "pointer",
  } satisfies CSSProperties,

  /** Version / framework dropdown trigger (`72:16737`, `72:16741`). */
  menuButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: t.space(1),
    height: 36,
    padding: `0 ${t.space(3)}`,
    border: "none",
    background: "transparent",
    color: t.color.text,
    fontFamily: t.font.ui,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,

  menuPopover: {
    position: "absolute",
    top: "100%",
    right: 0,
    zIndex: 20,
    minWidth: 180,
    maxHeight: 320,
    overflowY: "auto",
    padding: t.space(1),
    borderRadius: t.radius.md,
    border: `1px solid ${t.color.border}`,
    background: t.color.surfaceRaised,
    boxShadow: t.shadow.popover,
  } satisfies CSSProperties,

  menuItem: (active: boolean): CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    borderRadius: t.radius.sm,
    background: active ? t.color.accentSoft : "transparent",
    color: active ? t.color.text : t.color.textMuted,
    fontFamily: t.font.ui,
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    padding: `6px ${t.space(2)}`,
    cursor: "pointer",
    whiteSpace: "nowrap",
  }),

  /** Body column wrapper — bars stack above the pane, which takes the rest.
   *  The editor/preview boundary (`line 72:15839`) is no longer drawn here: the
   *  splitter track between the two columns is that line. */
  column: (): CSSProperties => ({
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
  }),

  /** The splitter's own 1px grid track. At rest it *is* the editor/preview border,
   *  full body height (`85:11001`: y=72, h=828 — through both row-2 bars and both
   *  status bars).
   *
   *  `zIndex` is load-bearing: the hit area and the active bar overflow ±4px into
   *  the neighbouring columns, and `previewPane` is `position: relative` and later
   *  in the DOM, so without it the preview paints over both. */
  splitter: {
    position: "relative",
    zIndex: 20,
    background: t.color.border,
    cursor: "col-resize",
    // The handle is focusable; the ring would be a 1px slit, so the active bar is
    // the focus affordance instead (see `splitterBar`).
    outline: "none",
  } satisfies CSSProperties,

  /** Pointer target, widened past the 1px line without widening the line. */
  splitterHit: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -SPLITTER_HIT_SLOP,
    right: -SPLITTER_HIT_SLOP,
    cursor: "col-resize",
  } satisfies CSSProperties,

  /** The 3px accent seam of the drag frames. Painted as an overflowing child so
   *  the track stays 1px and nothing reflows when it appears. */
  splitterBar: (active: boolean): CSSProperties => ({
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -1,
    width: 3,
    background: t.color.splitterActive,
    opacity: active ? 1 : 0,
    pointerEvents: "none",
  }),

  /** Covers the window while dragging. One element solves three problems: the
   *  preview iframe would otherwise swallow the pointer, CodeMirror would select
   *  text under the drag, and the cursor would flicker between the panes.
   *  `setPointerCapture` on the handle is kept as well — cross-origin frames are
   *  worth belt and braces. */
  splitterOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 40,
    cursor: "col-resize",
    userSelect: "none",
  } satisfies CSSProperties,

  spacer: { flex: 1 } satisfies CSSProperties,

  sidebar: {
    display: "flex",
    flexDirection: "column",
    // BOX INFO + FILES at the top, DEPENDENCIES pinned to the bottom (72:16975).
    justifyContent: "space-between",
    borderRight: `1px solid ${t.color.border}`,
    // Recessed relative to the panes — #000000 in dark (31:6438).
    background: t.color.surfaceSunken,
    // No scroll here: the FILES body scrolls instead, so DEPENDENCIES stays pinned.
    overflow: "hidden",
    minHeight: 0,
  } satisfies CSSProperties,

  // `fileItem` is gone: the sidebar's rows carry their own styles in `FileTree.tsx`,
  // and their fills live in the app's global block so `:hover` can reach them.

  // CodeMirror's slot between the tab strip and the status bar. `overflow: hidden`
  // is load-bearing: without it the editor's scroller pushes the status bar out of
  // the pane instead of scrolling inside its own box.
  //
  // This replaced `editorPane`, T2's wrapper around CodeEditor, when T4's tabs and
  // status bar arrived — the editor column is now `s.column` and this is just the
  // middle slot, so it carries the editor background `editorPane` used to.
  // `position: relative` since DEV-2169: this is now the containing block for one
  // absolutely-positioned pane per open tab (see `editorPane` below).
  editorBody: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    overflow: "hidden",
    background: t.color.editorBg,
  } satisfies CSSProperties,

  /**
   * One open file's editor, stacked inside `editorBody` (DEV-2169). Every open tab
   * stays mounted so switching keeps its undo history and scroll position; only the
   * active one is visible.
   *
   * Two things here are load-bearing and easy to "simplify" wrongly:
   *
   *  - **`visibility: hidden`, not `display: none`.** A CM6 view with no dimensions
   *    mismeasures its own gutters, so a `display: none` pane comes back with the
   *    line numbers out of alignment. Hidden panes keep their real box.
   *  - **Both states are `position: absolute; inset: 0`.** `CodeEditor` asks for
   *    `height: 100%`, which resolves today only because it is a direct child of a
   *    flex item with a definite height. A static wrapper would resolve that against
   *    `auto` and collapse the editor to nothing.
   */
  editorPane: (visible: boolean): CSSProperties => ({
    position: "absolute",
    inset: 0,
    visibility: visible ? "visible" : "hidden",
  }),

  /** Nothing open — every tab was closed. No frame draws this (ADR-0023 rule 1). */
  editorEmpty: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: t.space(4),
    textAlign: "center",
    fontFamily: t.font.ui,
    fontSize: 13,
    color: t.color.textMuted,
  } satisfies CSSProperties,

  previewPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    background: t.color.previewBg,
    display: "flex",
    flexDirection: "column",
  } satisfies CSSProperties,

  previewIframe: {
    border: "none",
    width: "100%",
    height: "100%",
    flex: 1,
  } satisfies CSSProperties,

  /**
   * The 28px bottom band, shared by both panes: `48:6740` (editor) and `48:6701`
   * (preview) are both y=800 h=28 inside their own column frame, so they read as one
   * rule spanning the window. Sharing the object is what keeps them flush — consumers
   * add only their own inner layout (the editor's 24px segment gaps, the preview's
   * left/right split).
   *
   * `editorBg`, not `surfaceMuted` and not `previewBg`: measured #ffffff / #19191c off
   * the frames (see open item 7). `previewBg` is #070604 in dark — a step darker, while
   * the frames draw this band *lighter* than the preview surround, not level with it.
   */
  paneStatusBar: {
    display: "flex",
    alignItems: "center",
    height: 28,
    padding: "4px 16px",
    boxSizing: "border-box",
    flexShrink: 0,
    borderTop: `1px solid ${t.color.border}`,
    background: t.color.editorBg,
    fontFamily: t.font.ui,
    fontSize: 10,
    lineHeight: "20px",
    color: t.color.textMuted,
    whiteSpace: "nowrap",
    overflow: "hidden",
  } satisfies CSSProperties,

  select: {
    fontFamily: t.font.mono,
    fontSize: 13,
    padding: `5px 8px`,
    borderRadius: t.radius.md,
    border: `1px solid ${t.color.border}`,
    background: t.color.surface,
    color: t.color.text,
  } satisfies CSSProperties,

  shareLink: {
    fontFamily: t.font.mono,
    fontSize: 12,
    color: t.color.accent,
    textDecoration: "none",
    maxWidth: 260,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
};
