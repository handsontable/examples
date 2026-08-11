// Avatar button + account popover in the top bar (`114:21480`, `114:21792`).
//
// Frame: a 36×36 circular avatar at the right end of row 1, opening a 120px
// popover with My demos / Settings / a rule / Log out, each 32px tall with a
// 16px icon.
//
// The Settings row was drawn greyed through T9 because the page behind it did
// not exist; DEV-2166 built it, so the row is live whenever a consumer supplies
// `onSettings` (the shell has no router of its own to navigate with).
//
// The avatar is a monogram unless the user uploaded a picture — there is no
// third source, since the broker returns nothing but an email
// (`scope=openid email`) and no default picture exists (ADR-0007). This
// component stays presentational: it takes a resolved `avatarUrl` and a resolved
// `displayName`, and the app owns fetching both.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { IconChartBar, IconListDetails, IconLogin2, IconSettings2 } from "./icons/index.js";
import { theme } from "./theme.js";

export interface AccountMenuProps {
  /** The signed-in identity. Labels the control, and supplies the monogram when
   *  the profile has neither a name nor a picture. */
  email: string;
  /** The profile's display name, when one has resolved. Only affects the letter
   *  and the tooltip — the frame draws no name in the popover. */
  displayName?: string;
  /** The profile's avatar, when one has resolved. Absent -> monogram. */
  avatarUrl?: string | null;
  onMyDemos: () => void;
  /** `/admin`, the internal usage + cost panel (DEV-2030). Optional: it is an
   *  internal tool, and the frames model no row for it — see the comment on the
   *  row itself. */
  onUsage?: () => void;
  /** `/settings` (DEV-2166). Optional for the same reason `onMyDemos` is a
   *  callback at all: this package does no navigation. */
  onSettings?: () => void;
  onLogout: () => void;
}

export function AccountMenu({
  email,
  displayName,
  avatarUrl,
  onMyDemos,
  onUsage,
  onSettings,
  onLogout,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Same dismissal contract as `MenuButton`: listeners only while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = displayName?.trim() || email;
  const initial = (label.trim()[0] ?? "?").toUpperCase();

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: "0 0 auto" }}>
      <button
        type="button"
        // The uploaded image fills the circle, so the accent background would
        // only show through a transparent PNG's holes — keep it as the backdrop
        // and drop the padding that would letterbox a non-square upload.
        style={avatarButton}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${email}`}
        title={email}
      >
        {avatarUrl
          // No crop UI (`114:26833` draws none): centre-crop on render instead,
          // which is the only way a non-square upload stays a circle.
          ? <img src={avatarUrl} alt="" style={avatarImage} />
          : <span aria-hidden="true">{initial}</span>}
      </button>

      {open && (
        <div style={popover} role="menu" aria-label="Account">
          <MenuRow icon={<IconListDetails />} label="My demos" onClick={() => { setOpen(false); onMyDemos(); }} />
          {/* `/admin` (DEV-2030). Undesigned — the pre-redesign bar carried it as a
              loose `Usage` link next to `My demos`, and the frames model neither
              button, so ADR-0023 rule 1 keeps the working control and it follows
              `My demos` into the menu it moved to. */}
          {onUsage && (
            <MenuRow
              icon={<IconChartBar />}
              label="Usage"
              title="Usage and cost of the demo runner"
              onClick={() => { setOpen(false); onUsage(); }}
            />
          )}
          <MenuRow
            icon={<IconSettings2 />}
            label="Settings"
            onClick={onSettings ? () => { setOpen(false); onSettings(); } : undefined}
            disabled={!onSettings}
            title={onSettings ? "Your name, description and avatar" : "Profile settings are not available here"}
          />
          <div style={rule} role="separator" />
          <MenuRow icon={<IconLogin2 />} label="Log out" onClick={() => { setOpen(false); onLogout(); }} />
        </div>
      )}
    </div>
  );
}

function MenuRow({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={disabled ? undefined : "hot-menu-row"}
      style={menuRow(disabled)}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      {label}
    </button>
  );
}

/** The 36×36 circle. Keeps its inline `background` — it is the accent fill, not a
 *  rollover surface, and the universal `button:hover` filter supplies the hover. */
const avatarButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 36,
  height: 36,
  flex: "0 0 auto",
  padding: 0,
  border: "none",
  borderRadius: "50%",
  background: theme.color.accent,
  color: theme.color.accentContrast,
  fontFamily: theme.font.ui,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1,
  cursor: "pointer",
  overflow: "hidden",
};

const avatarImage: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const popover: CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: theme.space(2),
  zIndex: 30,
  width: 120,
  padding: theme.space(1),
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surfaceRaised,
  boxShadow: theme.shadow.popover,
};

// Enabled rows set no `background`: `.hot-menu-row` in the app's global block
// gives them a transparent base *and* the hover, and an inline value would
// outrank the hover (ADR-0026). The disabled row carries its own, because it
// has no class — and without one the UA's `buttonface` paints a grey slab.
const menuRow = (disabled?: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  width: "100%",
  height: 32,
  padding: `0 ${theme.space(2)}`,
  border: "none",
  borderRadius: theme.radius.sm,
  ...(disabled ? { background: "transparent" } : {}),
  color: disabled ? theme.color.textMuted : theme.color.text,
  opacity: disabled ? 0.5 : 1,
  fontFamily: theme.font.ui,
  fontSize: 13,
  textAlign: "left",
  whiteSpace: "nowrap",
  cursor: disabled ? "default" : "pointer",
});

const rule: CSSProperties = {
  height: 1,
  margin: `${theme.space(1)} 0`,
  background: theme.color.border,
};
