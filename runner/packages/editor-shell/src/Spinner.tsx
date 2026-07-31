// The shell's one spinner. Extracted from `PreviewPane` by T5, which needs it in three
// places at once (boot overlay, refresh overlay, syncing pill) and where the app's
// splash wants a fourth.
//
// The `hot-spin` keyframes live in `THEME_CSS` (theme.ts), not in a `<style>` here: an
// inline rule would be re-emitted once per mounted spinner.

import type { CSSProperties } from "react";
import { theme } from "./theme.js";

export interface SpinnerProps {
  /** Outer diameter in px. Defaults to 14 (11 for `onAccent`). */
  size?: number;
  /** The variant drawn on an accent-filled surface (the syncing pill): track and head
   *  invert so it reads against `accent` instead of against `surface`. */
  onAccent?: boolean;
  style?: CSSProperties;
}

export function Spinner({ size, onAccent, style }: SpinnerProps) {
  const d = size ?? (onAccent ? 11 : 14);
  return (
    <span
      aria-hidden="true"
      style={{
        width: d,
        height: d,
        border: `2px solid ${onAccent ? theme.color.accentContrastSoft : theme.color.border}`,
        borderTopColor: onAccent ? theme.color.accentContrast : theme.color.accent,
        borderRadius: "50%",
        display: "inline-block",
        flex: "0 0 auto",
        animation: "hot-spin 0.8s linear infinite",
        ...style,
      }}
    />
  );
}
