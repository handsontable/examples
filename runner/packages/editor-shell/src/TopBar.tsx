// Row 1 of the chrome (`72:15840`): logo · centred example pill · the mode action ·
// theme toggle · Download / Sign in. 72px tall, `surfaceRaised`.
//
// The pill is a slot: in play mode the app puts its example cascader there, in
// edit/share the demo title. Everything else is shell-owned.

import type { ReactNode } from "react";
import { AccountMenu } from "./AccountMenu.js";
import { IconDownload } from "./icons/index.js";
import { Spinner } from "./Spinner.js";
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
  /** Signed-in identity for the account menu (`114:21480`), and what the bar now
   *  keys "signed in" off — not the shell's `authed`, deliberately. `/share/:id`
   *  renders the editor as anonymous (read-only, no action bar) but the visitor
   *  may well have a session, and offering them "Sign in" then is wrong. */
  accountEmail?: string;
  onMyDemos?: () => void;
  onLogout?: () => void;

  /** The mode action, left of the theme toggle (`114:24402` and its three
   *  siblings). At most one of these is ever set, and **`EditorShell` decides
   *  which** — never this component. It cannot be derived here: `accountEmail`
   *  above is present on `/share/:id` for a signed-in visitor who is precisely
   *  the person who must not get a Fork button. See `EditorShell`'s call. */
  onFork?: () => void;
  forking?: boolean;
  onSave?: () => void;
  saving?: boolean;
  dirty?: boolean;
}

export function TopBar({
  examplePill,
  onDownload,
  onSignIn,
  accountEmail,
  onMyDemos,
  onLogout,
  onFork,
  forking,
  onSave,
  saving,
  dirty,
}: TopBarProps) {
  const logoUrl = useLogoUrl();
  return (
    <header style={s.topBar}>
      <img src={logoUrl} alt="Handsontable" style={{ height: 22, display: "block" }} />

      {examplePill}

      <div style={s.spacer} />

      {/* Fork in `play`, Save in `edit` — one slot, keyed by mode upstream. The
          frames draw it here, left of the toggle, in all four After Login
          workspaces, and they size it 49px: the label is `Fork`, not the old
          bar's `Fork this demo` (ADR-0025, audit A2). */}
      {onFork && (
        <button
          type="button"
          style={pending(modeActionButton, forking)}
          onClick={onFork}
          disabled={forking}
          aria-label={forking ? "Creating…" : undefined}
          title={forking ? "Creating…" : "Fork this demo into your own editable, shareable client demo"}
        >
          {forking ? <Spinner size={14} /> : "Fork"}
        </button>
      )}

      {onSave && (
        <button
          type="button"
          style={pending(modeActionButton, saving)}
          onClick={onSave}
          disabled={saving}
          aria-label={saving ? "Saving…" : undefined}
          title={saving ? "Saving…" : "Save this demo (Ctrl+S)"}
        >
          {saving ? <Spinner size={14} /> : dirty ? "Save •" : "Save"}
        </button>
      )}

      <ThemeToggle />

      {/* Download is gated on having files, not on auth. The design's top-right is
          "Download (authed) / Sign in (anon)" — `72:15697` draws `Sign in` alone —
          but Download has always worked for anonymous visitors, so ADR-0023 rule 1
          keeps it and the anonymous view shows both. See ADR-0027 §2. */}
      {onDownload && (
        <button type="button" style={actionButton} onClick={onDownload} title="Download this example (including your edits) as a .zip">
          <IconDownload />
          Download
        </button>
      )}

      {/* No icon: `72:15885` draws a download glyph here only because the frame
          was duplicated from the Download button. */}
      {!accountEmail && onSignIn && (
        <button type="button" style={actionButton} onClick={onSignIn}>
          Sign in
        </button>
      )}

      {accountEmail && onMyDemos && onLogout && (
        <AccountMenu email={accountEmail} onMyDemos={onMyDemos} onLogout={onLogout} />
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
  // Transparent, not `surface`: the secondary button is outline-only in the
  // frames. Light hid the difference (surface == surfaceRaised == #ffffff);
  // dark separates the ramp, and `surface` (#070604) read as a black block on
  // the #222222 bar.
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/**
 * Same button, with the box pinned so the in-flight swap cannot move anything.
 * The slot's content changes width four ways (`Fork` / `Save` / `Save •` /
 * a 14px spinner), and it sits left of the toggle and the avatar — an unpinned
 * box would shuffle the whole right-hand group the moment a request starts.
 * 72px is the widest resting label (`Save •`) plus the 12px padding either side.
 */
const modeActionButton: React.CSSProperties = {
  ...actionButton,
  justifyContent: "center",
  minWidth: 72,
};

/** A disabled button still carries whatever `cursor` its base style set, so an
 *  in-flight action goes on advertising itself as clickable. Matches what the
 *  preview bar's share icon does while it mints. */
const pending = (base: React.CSSProperties, busy?: boolean): React.CSSProperties =>
  busy ? { ...base, cursor: "default" } : base;
