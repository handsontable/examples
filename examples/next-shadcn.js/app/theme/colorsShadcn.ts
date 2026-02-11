/**
 * Handsontable theme colors mapped to shadcn CSS variables (globals.css).
 * Structure must match what tokens/main expects: palette (50–950), primary (100–600), white, black, transparent.
 * Uses var(--…) so the grid follows your shadcn theme and dark mode.
 */
export const colorsShadcn = {
  palette: {
    50: "var(--background)",
    100: "var(--muted)",
    200: "var(--border)",
    300: "var(--input)",
    400: "var(--muted-foreground)",
    500: "var(--muted-foreground)",
    600: "var(--muted-foreground)",
    700: "var(--foreground)",
    800: "var(--foreground)",
    900: "var(--foreground)",
    950: "var(--foreground)",
  },
  primary: {
    100: "var(--secondary)",
    200: "var(--muted)",
    300: "var(--muted)",
    400: "var(--primary)",
    500: "var(--primary)",
    600: "var(--primary)",
  },
  white: "var(--background)",
  black: "var(--foreground)",
  transparent: "transparent",
} as const;
