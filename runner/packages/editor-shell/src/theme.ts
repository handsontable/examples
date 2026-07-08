// Single source of branding tokens for the authoring shell and the public viewer.
// White-label: our tokens only — no CodeSandbox marks anywhere in the UI.
// (Sandpack is Apache-2.0; its license notice lives in source, never in the UI.)
// Refined against the Handsontable brand guide during the design pass.

export const theme = {
  color: {
    accent: "#1a8f5a", // Handsontable green
    accentHover: "#157a4c",
    accentContrast: "#ffffff",

    surface: "#ffffff",
    surfaceMuted: "#f4f6f8",
    border: "#e2e6ea",
    text: "#1f2933",
    textMuted: "#647382",

    // Editor / code surfaces (dark).
    editorBg: "#0f1720",
    editorGutter: "#0b121a",
    editorText: "#e6edf3",
    editorSelection: "#1f6feb44",

    // Syntax (aligned to the accent family; tuned in the design pass).
    synKeyword: "#7ee787",
    synString: "#a5d6ff",
    synNumber: "#f2cc60",
    synComment: "#8b949e",
    synFunction: "#d2a8ff",
    synVariable: "#e6edf3",

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
