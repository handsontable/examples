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
   * The preview holds a fixed half of the window and the *editor* absorbs the
   * sidebar — measured, not assumed: the preview column starts at x=864 of 1728
   * in both `72:15697` (sidebar collapsed) and `48:6560` (sidebar open at 240).
   * `1fr 1fr` would put the boundary at 984 with the sidebar open. T6 replaces
   * this with the draggable ratio.
   */
  body: (sidebarOpen: boolean): CSSProperties => ({
    display: "grid",
    gridTemplateColumns: sidebarOpen ? `${SIDEBAR_WIDTH}px minmax(0, 1fr) 50%` : "minmax(0, 1fr) 50%",
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

  /** Editor tab (`72:15815`). One open file at a time until T4. */
  tab: (active: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: t.space(1),
    height: 36,
    padding: `0 ${t.space(2)} 0 6px`,
    border: "none",
    borderBottom: `2px solid ${active ? t.color.accent : "transparent"}`,
    background: active ? t.color.surfaceMuted : "transparent",
    color: active ? t.color.text : t.color.textMuted,
    fontFamily: t.font.ui,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap",
  }),

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

  /**
   * The authed action bar (ADR-0023). Signed-in-only, in no frame — it exists so
   * anonymous visitors see exactly the two designed rows.
   */
  authedBar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: t.space(2),
    padding: `${t.space(2)} ${t.space(3)}`,
    flex: "0 0 auto",
    borderBottom: `1px solid ${t.color.border}`,
    background: t.color.surfaceMuted,
    fontFamily: t.font.ui,
    fontSize: 13,
    color: t.color.text,
  } satisfies CSSProperties,

  /** Body column wrapper — bars stack above the pane, which takes the rest.
   *  `divided` draws the editor/preview boundary (`line 72:15839`). */
  column: (divided?: boolean): CSSProperties => ({
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    borderRight: divided ? `1px solid ${t.color.border}` : undefined,
  }),

  spacer: { flex: 1 } satisfies CSSProperties,

  button: {
    fontFamily: t.font.ui,
    fontSize: 13,
    fontWeight: 600,
    border: `1px solid ${t.color.border}`,
    background: t.color.surface,
    color: t.color.text,
    borderRadius: t.radius.md,
    padding: `6px 14px`,
    cursor: "pointer",
  } satisfies CSSProperties,

  buttonPrimary: {
    border: `1px solid ${t.color.accent}`,
    background: t.color.accent,
    color: t.color.accentContrast,
  } satisfies CSSProperties,

  sidebar: {
    borderRight: `1px solid ${t.color.border}`,
    // Recessed relative to the panes — #000000 in dark (31:6438).
    background: t.color.surfaceSunken,
    overflowY: "auto",
    padding: t.space(2),
    minHeight: 0,
  } satisfies CSSProperties,

  fileItem: (active: boolean): CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    background: active ? t.color.accentSoft : "transparent",
    color: active ? t.color.text : t.color.textMuted,
    fontWeight: active ? 600 : 400,
    fontFamily: t.font.mono,
    fontSize: 12.5,
    padding: `4px 8px`,
    borderRadius: t.radius.sm,
    cursor: "pointer",
    whiteSpace: "nowrap",
  }),

  editorPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: t.color.editorBg,
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

  statusBar: (kind: "booting" | "ready" | "error"): CSSProperties => ({
    fontSize: 12,
    fontFamily: t.font.mono,
    padding: `4px 10px`,
    color:
      kind === "error" || kind === "ready" ? t.color.accentContrast : t.color.text,
    background:
      kind === "error" ? t.color.danger : kind === "ready" ? t.color.accent : t.color.surfaceMuted,
  }),

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
