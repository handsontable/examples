// The wordmark is a baked-in fill, not `currentColor`, and the SVGs are consumed as
// URLs via <img> — so a dark shell needs its own asset rather than inheriting a colour.
import logoDarkInk from "./logo.svg";
import logoLightInk from "./logo-light.svg";
import { useTheme } from "./useTheme.js";

/** Dark-ink wordmark. Correct on a light surface; kept as the default export path. */
export const logoUrl = logoDarkInk;

/** The wordmark that reads against the current shell surface. */
export function useLogoUrl(): string {
  const { mode } = useTheme();
  return mode === "dark" ? logoLightInk : logoDarkInk;
}
