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
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { IconX } from "./icons/index.js";
import { s } from "./styles.js";
import { installCss, theme } from "./theme.js";

/** Both drawers, one width. Ask AI shipped at 400 and Style at 380; the style
 *  panel is the one with a 130px label column beside a control, and it was the
 *  cramped one. */
export const DRAWER_WIDTH = 400;

export interface DrawerProps {
  /** Rendered in the title row, 15/600 with an optional leading icon — the docs
   *  assistant's title treatment (`.da-title`), which these panels now mirror. */
  title: string;
  /** Drawn before the title, 8px off it — the panel's identity mark. */
  icon?: ReactNode;
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
  /** Merged over the footer band's own style — the chat panel's composer is
   *  full-bleed on `surface`, where the style panel's buttons keep the padded
   *  `surfaceMuted` band. */
  footerStyle?: CSSProperties;
  width?: number;
}

export function Drawer({
  title,
  icon,
  label,
  onClose,
  children,
  subheader,
  footer,
  footerStyle,
  width = DRAWER_WIDTH,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);

  // Slide-in from the right, as the docs assistant enters (`.da-panel`'s 0.2s
  // transform). The panel mounts offscreen and moves to 0 one frame later — a
  // transition needs a painted "from" state, and setting the resting transform
  // in the same render as the mount would skip the animation entirely. Close is
  // an unmount in App.tsx, so there is no slide-out; matching the docs' exit
  // would mean keeping closed drawers mounted, which is a bigger contract change
  // than an entrance animation justifies.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

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
    <aside
      ref={panelRef}
      className="hot-drawer"
      data-entered={entered || undefined}
      style={{ width }}
      aria-label={label ?? title}
    >
      <header className="hot-drawer-header">
        <h2 className="hot-drawer-title">
          {icon}
          {title}
        </h2>
        <button
          type="button"
          className="hot-icon-btn hot-drawer-close"
          onClick={onClose}
          aria-label={`Close ${title.toLowerCase()}`}
        >
          <IconX size={20} />
        </button>
      </header>

      {subheader}

      {/* The only scrolling region: title row, subheader and footer stay put. */}
      <div className="hot-drawer-body">{children}</div>

      {footer !== undefined && <footer className="hot-drawer-foot" style={footerStyle}>{footer}</footer>}
    </aside>
  );
}

// A real stylesheet, not inline objects (the app-wide move off inline styles):
// registered once at module scope through `installCss`, colours as `var(--hot-…)`
// references so the mode flip keeps working. Only per-instance values stay inline
// — `width` (a prop) and the chat panel's `footerStyle` override.
//
// The choices the rules encode:
//  * `z-index` 900 — under `Dialog`'s 1000. A dialog opened from inside a drawer
//    (Share, from the preview bar) has to paint above it.
//  * It starts *below* the 72px top bar rather than at `top: 0`. The docs
//    assistant's own geometry (`.da-panel[data-open]`) is full-height, and this
//    panel tried that; measured, a 400px drawer then covered every top-bar
//    control from `100vw - 400px` rightward — not just the two panel triggers,
//    but Fork/Save, Download, the theme toggle and the account menu. That bar is
//    a workspace toolbar, not a docs-site header: "restyle the demo, then save
//    it" is the panel's main flow, and Ctrl+S was the only way left to finish it.
//    Height follows, or the panel overhangs the viewport by the height of the bar.
//  * Entrance is the docs assistant's 0.2s slide, transform-only so nothing
//    inside reflows; `data-entered` flips one frame after mount so the
//    transition has a painted "from" state.
//  * `controlBorder` on the panel edge and both rules, not `border`: in dark,
//    `border` *is* `surfaceRaised`, so all three hairlines would vanish
//    (ADR-0028). In light the two tokens share a value.
//  * The title is `type.base` at 600 with the icon inline (`.da-title`) — the
//    design's scale tops out at 12px (48:6560), so no third size for a heading.
//  * `.hot-drawer-close` sets no background: it would outrank
//    `.hot-icon-btn:hover` (ADR-0026).
const DRAWER_CSS = `
.hot-drawer{position:fixed;top:${s.topBar.height}px;right:0;height:calc(100% - ${s.topBar.height}px);max-width:95vw;z-index:900;display:flex;flex-direction:column;border-left:1px solid ${theme.color.controlBorder};background:${theme.color.surfaceRaised};box-shadow:${theme.shadow.panel};color:${theme.color.text};font-family:${theme.font.ui};transition:transform 0.2s ease;transform:translateX(100%)}
.hot-drawer[data-entered]{transform:translateX(0)}
.hot-drawer-header{display:flex;align-items:center;justify-content:space-between;gap:${theme.space(3)};flex:0 0 auto;padding:${theme.space(3)} ${theme.space(6)};border-bottom:1px solid ${theme.color.controlBorder}}
.hot-drawer-title{display:flex;align-items:center;gap:${theme.space(2)};margin:0;font-size:${theme.type.base.fontSize}px;line-height:${theme.type.base.lineHeight};font-weight:600;color:${theme.color.text}}
.hot-drawer-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:0 0 auto;margin-right:-4px;padding:0;border:none;border-radius:${theme.radius.md};color:${theme.color.textMuted};cursor:pointer}
.hot-drawer-body{flex:1;min-height:0;overflow-y:auto}
.hot-drawer-foot{flex:0 0 auto;padding:${theme.space(3)} ${theme.space(6)};border-top:1px solid ${theme.color.controlBorder};background:${theme.color.surfaceMuted}}
`;
installCss("hot-drawer-css", DRAWER_CSS);
