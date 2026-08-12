// The account pages' left column (`114:26608`). Mirrors the account menu's
// entries — same icons, same order.
//
// It lived in `MyDemos.tsx` while My Demos was the only page that had one; the
// Settings page (`114:26833`) draws the identical nav, and a second hand-kept
// copy would drift from the account menu the way the first one nearly did.
//
// Note the coupling this carries into the package: the hover states come from
// `.hot-menu-row`, which is defined in the *app's* global stylesheet
// (`apps/authoring/index.html`), not here — see ADR-0026. That is why enabled
// rows below set no `background` of their own: an inline value would outrank
// the stylesheet's hover and the rows would look dead.

import type { CSSProperties } from "react";
import { IconBook, IconListDetails, IconLogin2, IconSettings2 } from "./icons/index.js";
import { theme } from "./theme.js";

export interface SideNavProps {
  /** Which row is the current page. */
  active: "myDemos" | "settings" | "guide";
  onLogout: () => void;
}

export function SideNav({ active, onLogout }: SideNavProps) {
  return (
    <nav style={sideNav} aria-label="Account">
      <NavLink href="/my-demos" active={active === "myDemos"} icon={<IconListDetails />} label="My demos" />
      <NavLink href="/settings" active={active === "settings"} icon={<IconSettings2 />} label="Settings" />
      {/* `/guide` (DEV-2503) — the in-app how-to. `IconBook` is already in the set
          (it heads a README row elsewhere) and reads as documentation. */}
      <NavLink href="/guide" active={active === "guide"} icon={<IconBook />} label="Guide" />
      <div style={navRule} role="separator" />
      <button type="button" className="hot-menu-row" style={navRow} onClick={onLogout}>
        <IconLogin2 />
        Log out
      </button>
    </nav>
  );
}

function NavLink({
  href,
  active,
  icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <a
      href={href}
      className="hot-menu-row"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      style={navRow}
    >
      {icon}
      {label}
    </a>
  );
}

export const SIDE_NAV_WIDTH = 320;

const sideNav: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: theme.space(2),
  borderRight: `1px solid ${theme.color.border}`,
  background: theme.color.surfaceSunken,
  overflowY: "auto",
};

const navRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(3),
  height: 44,
  padding: `0 ${theme.space(4)}`,
  border: "none",
  borderRadius: theme.radius.md,
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
  textAlign: "left",
  textDecoration: "none",
  cursor: "pointer",
};

const navRule: CSSProperties = {
  height: 1,
  margin: `${theme.space(2)} ${theme.space(2)}`,
  background: theme.color.border,
};
