// Shared inline-style objects derived from the branding theme. Kept in one place
// so the shell reads as one intentional system rather than ad-hoc CSS.
import type { CSSProperties } from "react";
import { theme } from "./theme.js";

const t = theme;

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

  body: {
    display: "grid",
    gridTemplateColumns: "220px minmax(0, 1fr) minmax(0, 1fr)",
    minHeight: 0,
    height: "100%",
  } satisfies CSSProperties,

  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: t.space(3),
    padding: `${t.space(2)} ${t.space(4)}`,
    borderBottom: `1px solid ${t.color.border}`,
    background: t.color.surface,
  } satisfies CSSProperties,

  brand: {
    display: "flex",
    alignItems: "center",
    gap: t.space(2),
    fontWeight: 700,
    letterSpacing: "-0.01em",
  } satisfies CSSProperties,

  frameworkTag: {
    fontSize: 12,
    fontWeight: 600,
    color: t.color.accent,
    background: `${t.color.accent}14`,
    border: `1px solid ${t.color.accent}33`,
    borderRadius: t.radius.sm,
    padding: `2px 8px`,
  } satisfies CSSProperties,

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
    background: t.color.surfaceMuted,
    overflowY: "auto",
    padding: t.space(2),
    minHeight: 0,
  } satisfies CSSProperties,

  fileItem: (active: boolean): CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    background: active ? `${t.color.accent}18` : "transparent",
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
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: `1px solid ${t.color.border}`,
    background: t.color.editorBg,
  } satisfies CSSProperties,

  previewPane: {
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    background: "#fff",
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
      kind === "error" ? "#fff" : kind === "ready" ? t.color.accentContrast : t.color.text,
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
