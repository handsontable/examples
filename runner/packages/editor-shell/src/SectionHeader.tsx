// Shared chrome for the three sidebar sections (`72:16979`, `72:16992`, `72:17066`).
// Lives in its own module rather than inside `Sidebar.tsx` because `FileTree` renders
// its own section header — importing it from `Sidebar` would be a cycle.
import type { CSSProperties, ReactNode } from "react";
import { IconChevronDown, IconChevronRight } from "./icons/index.js";
import { theme } from "./theme.js";

export interface SectionHeaderProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Rendered left of the collapse chevron (download-all, file CRUD). */
  actions?: ReactNode;
  /** First section carries no rule — the divider sits on top of the ones below it. */
  divided?: boolean;
}

export function SectionHeader({ label, collapsed, onToggle, actions, divided = true }: SectionHeaderProps) {
  const Chevron = collapsed ? IconChevronRight : IconChevronDown;
  return (
    <div style={divided ? { ...headerRow, borderTop: `1px solid ${theme.color.border}` } : headerRow}>
      <span style={headerLabel}>{label}</span>
      <span style={headerActions}>
        {actions}
        <button
          type="button"
          className="hot-icon-btn"
          style={iconBtn}
          aria-expanded={!collapsed}
          title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          onClick={onToggle}
        >
          <Chevron />
        </button>
      </span>
    </div>
  );
}

/** 16px box, no padding — the design spaces header icons by an 8px gap, not by hit area. */
export const iconBtn: CSSProperties = {
  display: "flex",
  border: "none",
  background: "none",
  padding: 0,
  cursor: "pointer",
  color: theme.color.textMuted,
  borderRadius: theme.radius.sm,
};

const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: `${theme.space(2)} ${theme.space(3)}`,
  background: theme.color.surface,
  flex: "0 0 auto",
};

/** The design's small-caps section-header type (`72:18121`, `72:16981`). Exported
 *  because T7's cascader groups use the identical treatment — sharing it is why
 *  this module exists rather than living inside `Sidebar`. */
export const headerLabel: CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 10,
  lineHeight: "20px",
  letterSpacing: 0.8,
  textTransform: "uppercase",
  color: theme.color.textMuted,
};

const headerActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  flexShrink: 0,
};
