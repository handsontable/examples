// Row 1 of the chrome (`72:15840`): logo · centred example pill · the mode action ·
// theme toggle · Download. 72px tall, `surfaceRaised`. (Sign in moved to the
// preview status bar — DEV-2505.)
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
  /** App-owned buttons, rendered as a group left of the mode action.
   *
   *  A slot rather than props, because what goes here is not shell chrome: the
   *  authoring app puts its **Ask AI** and **Style** triggers here, and both own
   *  their popovers and their explanatory tooltips. The old pre-redesign bar
   *  held them inline; the frames model neither, so ADR-0023 rule 1 keeps the
   *  working controls and this is where they fit. See ADR-0027. */
  secondaryActions?: ReactNode;
  /** Download the current files as a .zip. Hidden when absent. */
  onDownload?: () => void;
  /** Highlight Download because the open workspace has edits that nothing is
   *  going to persist (`play` and `share` keep them in memory only). The one way
   *  out with your changes has to be visible *before* a refresh takes them. */
  downloadHighlight?: boolean;
  /** Signed-in identity for the account menu (`114:21480`), and what the bar now
   *  keys "signed in" off — not the shell's `authed`, deliberately. `/share/:id`
   *  renders the editor as anonymous (read-only, no action bar) but the visitor
   *  may well have a session, and offering them "Sign in" then is wrong. */
  accountEmail?: string;
  /** The signed-in user's profile (DEV-2166), when it has resolved. Both are
   *  optional and arrive late: the bar renders the monogram immediately and
   *  swaps the picture in, rather than blocking the chrome on a fetch. */
  accountDisplayName?: string;
  accountAvatarUrl?: string | null;
  onMyDemos?: () => void;
  /** The internal usage + cost panel (`/admin`, DEV-2030). Signed-in only, and
   *  in the account menu rather than the bar: the pre-redesign bar had it as a
   *  loose `Usage` link beside `My demos`, and My demos is now a menu row. */
  onUsage?: () => void;
  /** `/settings` — the profile page (DEV-2166). Absent leaves the menu row
   *  disabled, which is what the anonymous-adjacent surfaces want. */
  onSettings?: () => void;
  /** `/guide` (DEV-2503), reaching the account menu. */
  onGuide?: () => void;
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
  secondaryActions,
  onDownload,
  downloadHighlight,
  accountEmail,
  accountDisplayName,
  accountAvatarUrl,
  onMyDemos,
  onUsage,
  onSettings,
  onGuide,
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

      {secondaryActions}

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
        <button
          type="button"
          style={
            downloadHighlight
              // `accentText`, not `accent`: this bar is `surfaceRaised`, where plain
              // `accent` is 2.3:1 — the one state that is supposed to *catch the eye*
              // was the hardest thing on the bar to read (DEV-2209).
              ? { ...actionButton, color: theme.color.accentText, borderColor: theme.color.accentText }
              : actionButton
          }
          onClick={onDownload}
          title={
            downloadHighlight
              ? "Your edits are not saved anywhere — download the example with your changes as a .zip"
              : "Download this example (including your edits) as a .zip"
          }
        >
          <IconDownload />
          Download{downloadHighlight ? " •" : ""}
        </button>
      )}

      {/* Sign in used to sit here, beside Download (`72:15697`). It moved to the
          preview status bar in DEV-2505: signing in is `@handsontable.com`-only
          and internal, while most visitors to this page are external (a client on
          a share link, someone arriving from the docs), so a top-bar button read
          as a call to action aimed at people who cannot use it. The account menu
          below stays — it only renders for a resolved user. */}
      {accountEmail && onMyDemos && onLogout && (
        <AccountMenu
          email={accountEmail}
          displayName={accountDisplayName}
          avatarUrl={accountAvatarUrl}
          onMyDemos={onMyDemos}
          onUsage={onUsage}
          onSettings={onSettings}
          onGuide={onGuide}
          onLogout={onLogout}
        />
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
  // `controlBorder`, not `border`: dark `border` *is* `surfaceRaised` (#222222),
  // so on this bar the outline vanished and Fork / Save / Download / Sign in
  // rendered as bare text. `72:15648` draws it at horizon/palette/600.
  border: `1px solid ${theme.color.controlBorder}`,
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
