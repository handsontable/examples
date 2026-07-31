// The BOX INFO section (`72:16978`): title, description, product badge, created date.
// Display only — every value arrives as a prop, nothing is fetched or derived here.
import type { CSSProperties } from "react";
import { SectionHeader } from "./SectionHeader.js";
import { markUrl } from "./useLogoUrl.js";
import { theme } from "./theme.js";

export interface BoxInfoProps {
  /** Demo title, or the example's display name when there is no saved demo. */
  title: string;
  /** Absent for playground and docs examples — the row is dropped, not blanked. */
  description?: string;
  /** ISO timestamp from the demos table. Same: absent means no row. */
  createdAt?: string;
  collapsed: boolean;
  onToggle: () => void;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Sep 25th, 2026". Returns null for anything unparseable so a bad column can't
 *  render "Created Invalid Date" or throw. */
export function formatCreated(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getDate();
  const rem100 = day % 100;
  const suffix =
    rem100 >= 11 && rem100 <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${MONTHS[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

export function BoxInfo({ title, description, createdAt, collapsed, onToggle }: BoxInfoProps) {
  const created = createdAt ? formatCreated(createdAt) : null;

  return (
    <section style={section} aria-label="Box info">
      <SectionHeader label="Box info" collapsed={collapsed} onToggle={onToggle} divided={false} />
      {!collapsed && (
        <div style={body}>
          <div>
            <p style={titleText}>{title}</p>
            {description && <p style={descriptionText}>{description}</p>}
          </div>
          <div style={badge}>
            <img src={markUrl} alt="" style={badgeMark} />
            <span style={badgeLabel}>Handsontable</span>
          </div>
          {created && <p style={createdText}>Created {created}</p>}
        </div>
      )}
    </section>
  );
}

const section: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "0 0 auto",
};

const body: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  // 10px is the design's own step here and lands off the 4px scale on purpose.
  gap: 10,
  padding: `${theme.space(2)} ${theme.space(3)} ${theme.space(3)}`,
  background: theme.color.surface,
};

const titleText: CSSProperties = {
  margin: 0,
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: "20px",
  color: theme.color.text,
};

const descriptionText: CSSProperties = {
  margin: 0,
  fontFamily: theme.font.ui,
  fontSize: 10,
  lineHeight: "20px",
  color: theme.color.textMuted,
};

const badge: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
};

const badgeMark: CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 2,
  display: "block",
  flex: "0 0 auto",
};

const badgeLabel: CSSProperties = {
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: "20px",
  color: theme.color.text,
};

const createdText: CSSProperties = {
  margin: 0,
  fontFamily: theme.font.ui,
  fontSize: 10,
  lineHeight: "20px",
  color: theme.color.textMuted,
};
