/**
 * Handsontable theme colors mapped to shadcn CSS variables (globals.css).
 * Structure must match what tokens/main expects: palette (50–950), primary (100–600), white, black, transparent.
 * Uses var(--…) so the grid follows your shadcn theme and dark mode.
 */
export const colorsShadcn = {
  palette: {
    50: "var(--color-neutral-50)",
    100: "var(--color-neutral-200)",
    200: "var(--color-neutral-100)",
    300: "var(--color-neutral-300)",
    400: "var(--color-neutral-400)",
    500: "var(--color-neutral-500)",
    600: "var(--color-neutral-600)",
    700: "var(--color-neutral-700)",
    800: "var(--color-neutral-800)",
    900: "var(--color-neutral-900)",
    950: "var(--color-neutral-950)",
  },
  primary: {
    100: "var(--primary)",
    200: "var(--primary)",
    300: "var(--primary)",
    400: "var(--color-neutral-900)",
    500: "var(--primary)",
    600: "var(--color-neutral-800)",
  },
  white: "var(--background)",
  black: "var(--foreground)",
  transparent: "transparent",
}