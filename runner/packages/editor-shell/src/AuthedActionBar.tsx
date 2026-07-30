// Signed-in-only actions, in the right column above the preview (ADR-0023).
//
// Nothing here appears in any frame: Save/Share (edit), Embed/Fork (play), the
// custom-version input, and — via `extras` — My demos, the account row and the
// edit-mode title/description. The design budgeted no space for them in the two
// designed rows, so they get a bar of their own that anonymous visitors never
// see. That is what keeps the anonymous view matching the frames exactly.

import type { ReactNode } from "react";
import { s } from "./styles.js";
import { theme } from "./theme.js";

export interface AuthedActionBarProps {
  mode: "play" | "edit" | "share";
  onSave: () => void;
  onShare: () => void;
  onFork: () => void;
  onEmbed?: () => void;
  onVersionChange: (v: string) => void;
  embedding?: boolean;
  sharing?: boolean;
  saving?: boolean;
  dirty?: boolean;
  /** App-owned signed-in controls: My demos, account, title/description. */
  extras?: ReactNode;
}

export function AuthedActionBar({
  mode,
  onSave,
  onShare,
  onFork,
  onEmbed,
  onVersionChange,
  embedding,
  sharing,
  saving,
  dirty,
  extras,
}: AuthedActionBarProps) {
  return (
    <div style={s.authedBar} aria-label="Demo actions">
      {extras}

      {/* The share playground is read-only, so its version is pinned too. */}
      {mode !== "share" && (
        <input
          style={customVersion}
          defaultValue=""
          placeholder="custom version (e.g. 0.0.0-next-07941cf-…)"
          aria-label="Custom Handsontable version"
          title="Type any published version or a pkg.pr.new build, then press Enter"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) onVersionChange(v);
            }
          }}
        />
      )}

      <div style={s.spacer} />

      {mode === "edit" && (
        <>
          <button type="button" style={button} onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : dirty ? "Save •" : "Save"}
          </button>
          <button
            type="button"
            style={{ ...button, ...buttonPrimary }}
            onClick={onShare}
            title="Get the public client link and docs embed URL"
          >
            Share
          </button>
        </>
      )}

      {mode === "play" && (
        <>
          {onEmbed && (
            <button
              type="button"
              style={button}
              onClick={onEmbed}
              disabled={embedding}
              title="Create an embeddable (docs-only) version and copy its embed URL"
            >
              {embedding ? "Preparing…" : "Embed"}
            </button>
          )}
          <button
            type="button"
            style={{ ...button, ...buttonPrimary }}
            onClick={onFork}
            disabled={sharing}
            title="Fork this demo into your own editable, shareable client demo"
          >
            {sharing ? "Creating…" : "Fork this demo"}
          </button>
        </>
      )}
    </div>
  );
}

const button: React.CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 13,
  fontWeight: 600,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: theme.color.text,
  borderRadius: theme.radius.md,
  padding: "6px 14px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const buttonPrimary: React.CSSProperties = {
  border: `1px solid ${theme.color.accent}`,
  background: theme.color.accent,
  color: theme.color.accentContrast,
};

const customVersion: React.CSSProperties = {
  fontFamily: theme.font.mono,
  fontSize: 12,
  width: 260,
  padding: "5px 8px",
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: theme.color.text,
  boxSizing: "border-box",
};
