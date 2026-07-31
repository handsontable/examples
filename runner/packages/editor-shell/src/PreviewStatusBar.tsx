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
}

export function PreviewStatusBar({ status, frameworkName, version }: PreviewStatusBarProps) {
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
 *  the same clamp T2 needed for the version warning (open item 15). */
const clamp: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };
