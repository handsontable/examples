// Single source of branding tokens for the authoring shell and the public viewer.
// White-label: our tokens only — no CodeSandbox marks anywhere in the UI.
// (Sandpack is Apache-2.0; its license notice lives in source, never in the UI.)
// Refined against the Handsontable brand guide during the design pass.

export const theme = {
  color: {
    accent: "#1A42E8", // Handsontable blue
    accentHover: "#1233bf",
    accentContrast: "#ffffff",

    surface: "#ffffff",
    surfaceMuted: "#f3f5fb",
    border: "#e0e4f0",
    text: "#101828",
    textMuted: "#5b6472",

    // Editor / code surfaces (dark).
    editorBg: "#0f1424",
    editorGutter: "#0b1020",
    editorText: "#e6ebf5",
    editorSelection: "#1A42E844",

    // Syntax (blue-leaning family; the editor uses CodeMirror's own theme).
    synKeyword: "#8ab4ff",
    synString: "#a5c8ff",
    synNumber: "#7fd0ff",
    synComment: "#8b93a7",
    synFunction: "#b6a8ff",
    synVariable: "#e6ebf5",

    danger: "#d1242f",
    warning: "#bf8700",
  },
  font: {
    ui: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
    mono: `"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace`,
  },
  radius: { sm: "4px", md: "8px", lg: "12px" },
  space: (n: number) => `${n * 4}px`,
} as const;

export type Theme = typeof theme;
