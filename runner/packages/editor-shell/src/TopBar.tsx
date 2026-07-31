// Row 1 of the chrome (`72:15840`): logo · centred example pill · theme toggle ·
// Download / Sign in. 72px tall, `surfaceRaised`.
//
// The pill is a slot: in play mode the app puts its example cascader there, in
// edit/share the demo title. Everything else is shell-owned.

import type { ReactNode } from "react";
import { IconDownload } from "./icons/index.js";
import { s } from "./styles.js";
import { theme } from "./theme.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { useLogoUrl } from "./useLogoUrl.js";

export interface TopBarProps {
  /** Centred pill contents — cascader trigger, or the demo title. */
  examplePill?: ReactNode;
  /** Download the current files as a .zip. Hidden when absent. */
  onDownload?: () => void;
  /** Start the sign-in flow. Rendered only when anonymous. */
  onSignIn?: () => void;
  authed: boolean;
}

export function TopBar({ examplePill, onDownload, onSignIn, authed }: TopBarProps) {
  const logoUrl = useLogoUrl();
  return (
    <header style={s.topBar}>
      <img src={logoUrl} alt="Handsontable" style={{ height: 22, display: "block" }} />

      {examplePill}

      <div style={s.spacer} />

      <ThemeToggle />

      {/* Download is gated on having files, not on auth. The design's top-right is
          "Download (authed) / Sign in (anon)" — `72:15697` draws `Sign in` alone —
          but Download has always worked for anonymous visitors, so ADR-0023 rule 1
          keeps it and the anonymous view shows both. See open item 30. */}
      {onDownload && (
        <button type="button" style={actionButton} onClick={onDownload} title="Download this example (including your edits) as a .zip">
          <IconDownload />
          Download
        </button>
      )}

      {/* No icon: `72:15885` draws a download glyph here only because the frame
          was duplicated from the Download button. */}
      {!authed && onSignIn && (
        <button type="button" style={actionButton} onClick={onSignIn}>
          Sign in
        </button>
      )}
    </header>
  );
}

const actionButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: theme.space(2),
  height: 36,
  padding: `0 ${theme.space(3)}`,
  flex: "0 0 auto",
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surface,
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
