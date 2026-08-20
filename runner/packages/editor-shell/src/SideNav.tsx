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
import { IconBook, IconListDetails, IconLogin2, IconSettings2, IconUsers } from "./icons/index.js";
import { theme } from "./theme.js";

/** A child row under one of the sections — the guide's tracks (DEV-2522). */
export interface SideNavSubItem {
  href: string;
  label: string;
  active: boolean;
}

export interface SideNavProps {
  /** Which row is the current page. */
  active: "myDemos" | "allDemos" | "settings" | "guide";
  /** Rows nested under Guide. Only drawn when Guide is the current page: a
   *  four-item sub-list on My demos would be navigation for a page you are not on. */
  guideSubItems?: SideNavSubItem[];
  onLogout: () => void;
}

export function SideNav({ active, guideSubItems, onLogout }: SideNavProps) {
  return (
    <nav style={sideNav} aria-label="Account">
      <NavLink href="/my-demos" active={active === "myDemos"} icon={<IconListDetails />} label="My demos" />
      {/* `/all-demos` (DEV-2506) — the team's demos, read-only except your own.
          Directly under My demos because it is the same listing with a wider
          `WHERE`, and `IconUsers` says "other people's" without a word. */}
      <NavLink href="/all-demos" active={active === "allDemos"} icon={<IconUsers />} label="All demos" />
      <NavLink href="/settings" active={active === "settings"} icon={<IconSettings2 />} label="Settings" />
      {/* `/guide` (DEV-2503) — the in-app how-to. `IconBook` is already in the set
          (it heads a README row elsewhere) and reads as documentation. */}
      <NavLink href="/guide" active={active === "guide"} icon={<IconBook />} label="Guide" />
      {active === "guide" && guideSubItems && guideSubItems.length > 0 && (
        /* Indented rows, no icons: the icon column is what makes the four sections
           scannable, and repeating a book glyph four times would flatten it. The
           left rule does the nesting instead. */
        <div style={subNav} aria-label="Guide tracks" role="navigation">
          {guideSubItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="hot-menu-row"
              data-active={item.active ? "true" : undefined}
              aria-current={item.active ? "page" : undefined}
              style={subRow(item.active)}
            >
              {item.label}
            </a>
          ))}
        </div>
      )}
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
  gap: theme.space(1),
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
  ...theme.type.base,
  textAlign: "left",
  textDecoration: "none",
  cursor: "pointer",
};

const subNav: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  // Aligned under the parent row's label, not its icon, so the indent reads as
  // "inside Guide" rather than as a second column.
  margin: `${theme.space(1)} 0 ${theme.space(1)} ${theme.space(6)}`,
  paddingLeft: theme.space(3),
  borderLeft: `1px solid ${theme.color.border}`,
};

const subRow = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  height: 30,
  padding: `0 ${theme.space(2)}`,
  borderRadius: theme.radius.sm,
  // `accentText`, not `accent`: this is text on `surfaceSunken`, which in dark is
  // #000000 — plain brand blue reads as disabled there, which is why the token pair
  // exists at all.
  color: active ? theme.color.accentText : theme.color.textMuted,
  fontFamily: theme.font.ui,
  ...theme.type.base,
  textDecoration: "none",
  // No `background` when inactive: `.hot-menu-row`'s hover lives in the app's
  // stylesheet and an inline value would outrank it (ADR-0026).
});

const navRule: CSSProperties = {
  height: 1,
  margin: `${theme.space(2)} ${theme.space(2)}`,
  background: theme.color.border,
};
