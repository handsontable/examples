// Preview status bar, built to `48:6701` (light) / `72:15699` (dark).
//
// `● ready` on the left, `React (Vite, TS)` and `Handsontable 18.0.0` on the right. The
// `·` in the ticket is prose shorthand — the frame draws no separators, just a 12px gap
// between the two right-hand labels.
//
// This is deliberately NOT rendered inside `PreviewPane`'s `<section>`. Every overlay in
// that section is `position: absolute; inset: 0`, so a bar placed there would be painted
// over by the boot, error and refresh overlays. (The pre-T2 strip lived at the *top* and
// bought its way out with `inset: "28px 0 0 0"` on every overlay — do not go back to
// that.) It is the preview column's last child instead, mirroring `EditorStatusBar` under
// the editor body, which is also what lands the two bars in one flush 28px band.

import type { CSSProperties } from "react";
import type { PreviewStatus } from "./PreviewPane.js";
import { s } from "./styles.js";
import { theme } from "./theme.js";

/** `success` is the frame's own `component/notification/notification-success-accent`
 *  (#37bc6c, exact). The other two have no frame — no frame shows a booting or failed
 *  preview with the bar visible — so they take the matching semantic tokens. */
const DOT: Record<PreviewStatus, string> = {
  booting: theme.color.warning,
  ready: theme.color.success,
  error: theme.color.danger,
};

export interface PreviewStatusBarProps {
  status: PreviewStatus;
  /** Short project label — `React (Vite, TS)`. Omitted when nothing resolves it. */
  frameworkName?: string;
  /** Bare version; the `Handsontable` prefix belongs to this bar (`48:6707`). */
  version: string;
  /** Start the sign-in flow (DEV-2505). It lives here, not in the top bar, because
   *  the login is `@handsontable.com`-only: most visitors to this page cannot use
   *  it, and a top-bar button read as a call to action aimed at them. Passed only
   *  when nobody is signed in — `EditorShell` withholds it otherwise, and in full
   *  mode entirely. */
  onSignIn?: () => void;
}

export function PreviewStatusBar({ status, frameworkName, version, onSignIn }: PreviewStatusBarProps) {
  return (
    // Not `role="status"`/`aria-live`: booting → ready fires on every example switch and
    // every version change, and announcing each one is noise. The machine-readable
    // readiness signal is `data-preview-status` on the pane's `<section>`, which the
    // starter-matrix suite polls.
    <div style={s.paneStatusBar} aria-label="Preview status">
      <span style={left}>
        <span style={{ ...dot, background: DOT[status] }} />
        {status}
      </span>
      <span style={right}>
        {frameworkName && <span style={clamp}>{frameworkName}</span>}
        <span style={{ flex: "0 0 auto" }}>Handsontable {version}</span>
        {/* Last, and styled as bar text rather than as a control: findable by
            anyone looking for it, invisible to anyone who is not. It keeps the
            accessible name "Sign in" — every anonymous-state precondition in the
            e2e suite is written against it. */}
        {onSignIn && (
          <button type="button" style={signIn} onClick={onSignIn} title="Sign in (Handsontable team)">
            Sign in
          </button>
        )}
      </span>
    </div>
  );
}

const left: CSSProperties = { display: "flex", alignItems: "center", gap: 4 };

/** 6×6 at x=0 against a label at x=10 — a 4px gap (`48:6703`). */
const dot: CSSProperties = { width: 6, height: 6, borderRadius: "50%", flex: "0 0 auto" };

/** The right group is flush to 16px from the edge, which `paneStatusBar`'s padding
 *  already gives; `marginLeft: auto` pushes it there. */
const right: CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  alignItems: "center",
  gap: 12,
  minWidth: 0,
};

/** A long framework name yields to the version rather than shoving it out of the bar —
 *  the same clamp T2 needed for the version warning (DEV-2173). */
const clamp: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };

/** Inherits the bar's 11px muted type; only the underline says it is clickable.
 *  `background: none` matters — a bare <button> otherwise paints the UA's
 *  `buttonface` slab across the bar in both themes (the same trap ADR-0026
 *  documents for .hot-menu-row). */
const signIn: CSSProperties = {
  flex: "0 0 auto",
  border: "none",
  background: "none",
  padding: 0,
  font: "inherit",
  color: theme.color.textMuted,
  textDecoration: "underline",
  cursor: "pointer",
};
