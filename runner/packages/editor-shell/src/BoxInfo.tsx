// The BOX INFO section (`72:16978`): title, description, product badge, created date.
// Display only — every value arrives as a prop, nothing is fetched or derived here.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { SectionHeader, iconBtn } from "./SectionHeader.js";
import { IconPencil } from "./icons/index.js";
import { markUrl } from "./useLogoUrl.js";
import { theme } from "./theme.js";

export interface BoxInfoProps {
  /** Demo title, or the example's display name when there is no saved demo. */
  title: string;
  /**
   * Absent for playground and docs examples — the row is dropped, not blanked.
   *
   * A `ReactNode` since DEV-2507: descriptions are markdown, and the renderer that
   * turns them into elements lives in the app (`markdown.tsx`), not here. Passing
   * the rendered node keeps this package free of a parser it has no other use for,
   * and keeps one renderer behind the sidebar, the demo card and the shared page.
   */
  description?: ReactNode;
  /** ISO timestamp from the demos table. Same: absent means no row. */
  createdAt?: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Opens the Edit info dialog (`114:21684` — the pencil left of the chevron).
   *  Omitted wherever the title/description aren't editable: playground and docs
   *  examples have no demo row, and a share view isn't the owner's. */
  onEdit?: () => void;
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

export function BoxInfo({ title, description, createdAt, collapsed, onToggle, onEdit }: BoxInfoProps) {
  const created = createdAt ? formatCreated(createdAt) : null;

  // A markdown description can be several paragraphs, and the sidebar is 320px
  // wide with FILES underneath it: unclamped, a long one pushes the file tree off
  // the screen. Clamped to ~5 lines, with a toggle that only appears when there is
  // something to reveal — measured, because "long" depends on the wrapping.
  const descriptionRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = descriptionRef.current;
    if (!node) {
      setOverflows(false);
      return;
    }
    // `scrollHeight` against the clamp, not a character count: two lines of one
    // long word and five short lines are the same length and different heights.
    setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [description, collapsed, expanded]);

  return (
    <section style={section} aria-label="Box info">
      <SectionHeader
        label="Box info"
        collapsed={collapsed}
        onToggle={onToggle}
        divided={false}
        actions={
          onEdit && (
            <button type="button" className="hot-icon-btn" style={iconBtn} title="Edit info" onClick={onEdit}>
              <IconPencil />
            </button>
          )
        }
      />
      {!collapsed && (
        <div style={body}>
          <div>
            <p style={titleText}>{title}</p>
            {description && (
              <>
                <div
                  ref={descriptionRef}
                  style={descriptionText(expanded)}
                  data-expanded={expanded ? "true" : undefined}
                >
                  {description}
                </div>
                {(overflows || expanded) && (
                  <button type="button" style={moreButton} onClick={() => setExpanded((v) => !v)}>
                    {expanded ? "Show less" : "Show more"}
                  </button>
                )}
              </>
            )}
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

/** Collapsed: five 20px lines. Expanded: as tall as it needs, and the sidebar's
 *  own scroll takes over — the FILES body below has its own (see `FileTree`). */
const descriptionText = (expanded: boolean): CSSProperties => ({
  margin: 0,
  fontFamily: theme.font.ui,
  fontSize: 10,
  lineHeight: "20px",
  color: theme.color.textMuted,
  ...(expanded ? {} : { maxHeight: 100, overflow: "hidden" }),
});

const moreButton: CSSProperties = {
  margin: `2px 0 0`,
  padding: 0,
  border: "none",
  background: "none",
  color: theme.color.accentText,
  fontFamily: theme.font.ui,
  fontSize: 10,
  lineHeight: "16px",
  cursor: "pointer",
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
