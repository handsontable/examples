// Right-hand drawer shell — panel, title row, close button, optional footer
// (DEV-2209).
//
// The two app-owned drawers, Ask AI and Style, each hand-rolled this: their own
// `aside`, their own header, their own `✕`, at two different widths and neither
// matching the title treatment `Dialog` draws. No frame draws either panel
// (ADR-0023 rule 1), so the design source is `Dialog` itself — same 18/600 title,
// same bare `tabler-icon-x` — restated for a surface that is not a modal card.
//
// The differences from `Dialog` are the point, and all three follow from the
// drawer being **non-modal**:
//   * no scrim — the editor behind stays visible and usable
//   * no focus trap — Apply / Undo exist so you can watch the file change while
//     the panel is open; trapping focus would fight that
//   * Escape on the *bubble* phase (see below)

import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconX } from "./icons/index.js";
import { s } from "./styles.js";
import { theme } from "./theme.js";

/** Both drawers, one width. Ask AI shipped at 400 and Style at 380; the style
 *  panel is the one with a 130px label column beside a control, and it was the
 *  cramped one. */
export const DRAWER_WIDTH = 400;

export interface DrawerProps {
  /** Rendered in the title row, 18/600, as `Dialog` draws it. */
  title: string;
  /** The panel's accessible name. Defaults to `title`; the two panels give the
   *  fuller sentence their `aside` carried before ("Ask about this example"). */
  label?: string;
  /** Escape and the close button both route here. */
  onClose: () => void;
  children: ReactNode;
  /** Pinned directly below the title row, above the scrolling body — the style
   *  panel's tab strip. Inside `children` it would scroll away from the content
   *  it switches. */
  subheader?: ReactNode;
  /** Pinned below the scrolling body, on `surfaceMuted`. */
  footer?: ReactNode;
  width?: number;
}

export function Drawer({
  title,
  label,
  onClose,
  children,
  subheader,
  footer,
  width = DRAWER_WIDTH,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);

  /**
   * Who had focus when this drawer opened — captured **during the first render**,
   * not in a mount effect, and restored only if focus is still ours to give back.
   *
   * Both halves are about swapping one drawer for the other in a single commit
   * (`App.tsx` closes one panel as it opens the other):
   *
   *  - React runs a deleted subtree's effect cleanups *before* the new subtree's
   *    mount effects, so reading `activeElement` on mount saw whatever the closing
   *    drawer had just focused — its own trigger — and every later Escape sent
   *    focus to the wrong button. Render happens before that cleanup, so this
   *    initialiser sees the trigger the user actually clicked.
   *  - And the closing drawer must not focus its trigger at all here: focus has
   *    already moved to the other panel's button, taking it back both stole it and
   *    fired that trigger's `onFocus`, so the closed panel's tooltip appeared over
   *    the open one.
   */
  const returnTo = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  useEffect(() => () => {
    const active = document.activeElement;
    const ours = !active || active === document.body || !!panelRef.current?.contains(active);
    if (ours) returnTo.current?.focus?.();
  }, []);

  useEffect(() => {
    // Bubble phase, deliberately. `Dialog` listens on `document` with *capture*
    // and calls `stopPropagation()` — but `stopPropagation` does not stop other
    // listeners on the same node in the same phase, so a second capture listener
    // here would still fire and one Escape would close both a dialog and the
    // drawer beneath it. On bubble, `Dialog` swallows the key first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Blur first, then close. Several fields inside the style panel commit
      // `onBlur` rather than per keystroke (a hex or a `1.5rem` is only a value
      // once it is finished), and React fires no blur on unmount — so closing
      // straight from a focused field would drop what was typed. Clicking ✕ moves
      // focus and commits on its own; Escape is the path that needed this.
      (document.activeElement as HTMLElement | null)?.blur?.();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside ref={panelRef} style={{ ...panel, width }} aria-label={label ?? title}>
      <header style={titleRow}>
        <h2 style={heading}>{title}</h2>
        <button
          type="button"
          className="hot-icon-btn"
          style={closeButton}
          onClick={onClose}
          aria-label={`Close ${title.toLowerCase()}`}
        >
          <IconX size={20} />
        </button>
      </header>

      {subheader}

      {/* The only scrolling region: title row, subheader and footer stay put. */}
      <div style={body}>{children}</div>

      {footer !== undefined && <footer style={foot}>{footer}</footer>}
    </aside>
  );
}

// `zIndex` 900 — under `Dialog`'s 1000. A dialog opened from inside a drawer
// (Share, from the preview bar) has to paint above it.
//
// It starts *below* the 72px top bar rather than at `top: 0`, which is what both
// panels used to do. Covering the bar covered their own triggers: with a drawer
// open, the other panel's button — and the open one's own toggle — sat under the
// panel, and Playwright reported the `<h2>` intercepting the click. Mutually
// exclusive panels you cannot switch between with the mouse are only mutually
// exclusive on paper (Escape and ✕ were the only ways out). Height follows, or the
// panel would overhang the viewport by the height of the bar.
const panel: CSSProperties = {
  position: "fixed",
  top: s.topBar.height,
  right: 0,
  height: `calc(100% - ${s.topBar.height}px)`,
  maxWidth: "95vw",
  zIndex: 900,
  display: "flex",
  flexDirection: "column",
  // `controlBorder`, not `border`: in dark, `border` *is* `surfaceRaised`, so the
  // drawer's own edge against the workspace would vanish (theme.ts, ADR-0028).
  borderLeft: `1px solid ${theme.color.controlBorder}`,
  background: theme.color.surfaceRaised,
  boxShadow: theme.shadow.panel,
  color: theme.color.text,
  fontFamily: theme.font.ui,
};

const titleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space(3),
  flex: "0 0 auto",
  padding: `${theme.space(3)} ${theme.space(4)}`,
  // A divider between two same-tone regions, so `border` is right here — the rule
  // reads in both modes and `controlBorder` would make it shout (ADR-0028).
  borderBottom: `1px solid ${theme.color.border}`,
};

const heading: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
  color: theme.color.text,
};

// No inline `background`: it would outrank `.hot-icon-btn:hover` (ADR-0026).
const closeButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  flex: "0 0 auto",
  marginRight: -4,
  padding: 0,
  border: "none",
  borderRadius: theme.radius.md,
  color: theme.color.textMuted,
  cursor: "pointer",
};

const body: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
};

const foot: CSSProperties = {
  flex: "0 0 auto",
  padding: `${theme.space(3)} ${theme.space(4)}`,
  borderTop: `1px solid ${theme.color.border}`,
  background: theme.color.surfaceMuted,
};
