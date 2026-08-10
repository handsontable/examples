// Avatar button + account popover in the top bar (`114:21480`, `114:21792`).
//
// Frame: a 36×36 circular avatar at the right end of row 1, opening a 120px
// popover with My demos / Settings / a rule / Log out, each 32px tall with a
// 16px icon. Settings is drawn greyed — the Settings page (`114:26833`) is a
// separate feature (new profile table + endpoints + avatar storage), split out
// of T9, so the row is present and disabled rather than absent.
//
// The avatar is the first letter of the email. `auth.ts` carries `{ email, sub,
// exp }` and nothing else — no display name, no picture — and this deliberately
// takes no dependency on the external login broker growing either.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { IconChartBar, IconListDetails, IconLogin2, IconSettings2 } from "./icons/index.js";
import { theme } from "./theme.js";

export interface AccountMenuProps {
  /** The signed-in identity. The avatar's letter and the menu's label come from it. */
  email: string;
  onMyDemos: () => void;
  /** `/admin`, the internal usage + cost panel (DEV-2030). Optional: it is an
   *  internal tool, and the frames model no row for it — see the comment on the
   *  row itself. */
  onUsage?: () => void;
  onLogout: () => void;
}

export function AccountMenu({ email, onMyDemos, onUsage, onLogout }: AccountMenuProps) {
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

  const initial = (email.trim()[0] ?? "?").toUpperCase();

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: "0 0 auto" }}>
      <button
        type="button"
        style={avatarButton}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${email}`}
        title={email}
      >
        <span aria-hidden="true">{initial}</span>
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
            disabled
            title="Profile settings are not built yet"
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
