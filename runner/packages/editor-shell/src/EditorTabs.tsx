// Editor file-tab strip, built to frames `48:6560` (light) / `31:6438` (dark).
//
// **Multiple open files** (ADR-0025 §3, DEV-2169). T4 shipped this strip styled
// with a single open file and both tab states already written out, betting that
// real multi-tab would be a state change rather than a restyle — which is how it
// turned out. What T4 could not express is the interaction, and that is what
// changed shape here:
//
//   * A tab is a `<div role="tab">`, not a `<button>`. The close control is a real
//     button now, and a `<button>` inside a `<button>` is invalid HTML — the same
//     reason `FileTree`'s rows are divs wrapping their own buttons.
//   * So this file owns activation (click, Enter, Space), the roving `tabindex`
//     (Left/Right/Home/End) and Delete/Backspace-to-close, none of which a native
//     button gave away for free.
//
// **The glyph slot is always occupied**, so a tab never changes width: the ✕ at
// rest, the unsaved-changes dot in its place when that file is dirty, and the ✕
// back again on hover or focus so closing is always reachable (ADR-0025 §3 —
// `114:21146` draws `tabler-icon-circle` on the active tab
// where every other tab in the file draws `tabler-icon-x`).
//
// The swap lives in the app's global block, not here: `:hover` is unreachable
// from inline styles, and an inline value on the same property would outrank the
// stylesheet rule anyway — including `transparent` (ADR-0026). Hence
// `.hot-tab` / `.hot-tab-x` / `.hot-tab-dot` and no inline `display` or
// `background` on any of them.

import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { FileIcon, IconCircleFilled, IconX } from "./icons/index.js";
import { theme } from "./theme.js";

/** 24px in the frames — larger than the 16px the file tree uses. */
const TAB_ICON_SIZE = 24;

/** The strip itself. `EditorShell` needs to reach it to park focus there when the last
 *  tab is closed and there is no tab left to hand focus to. */
export const TAB_STRIP_ID = "hot-tab-strip";

/** Ties each tab to the pane it selects, so `aria-selected` refers to something.
 *  Shared with `EditorShell`, which stamps the matching ids on the panes. */
export function tabId(path: string): string {
  return `hot-tab-${encodeURIComponent(path)}`;
}
export function tabPanelId(path: string): string {
  return `hot-tabpanel-${encodeURIComponent(path)}`;
}

export interface EditorTabsProps {
  /** Open files, in tab order. */
  paths: string[];
  active: string;
  onSelect: (path: string) => void;
  /** Closes a tab. The shell activates a neighbour; nothing is written or lost —
   *  contents live in the app's `files` map, and a tab is only a view of one. */
  onClose: (path: string) => void;
  /** Files edited since the last save, for the unsaved-changes dot. Workspace-level
   *  `dirty` is deliberately *not* used: it is one boolean for the whole workspace,
   *  so an edit to one file would dot every open tab. */
  dirtyPaths?: ReadonlySet<string>;
}

export function EditorTabs({ paths, active, onSelect, onClose, dirtyPaths }: EditorTabsProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  // Roving tabindex: only the active tab is in the tab order, and the arrows move
  // *focus* rather than selection, so a keyboard user can reach a tab's ✕ without
  // switching files on the way past. Focus is moved by querying the DOM rather than
  // held in state — the strip is small, and this keeps `active` the one source of
  // truth for which tab is selected.
  const focusTab = (index: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    const tabs = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    if (!tabs.length) return;
    tabs[(index + tabs.length) % tabs.length]?.focus();
  };

  const onKeyDown = (path: string, i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        focusTab(i - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        focusTab(i + 1);
        break;
      case "Home":
        e.preventDefault();
        focusTab(0);
        break;
      case "End":
        e.preventDefault();
        focusTab(paths.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect(path);
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        onClose(path);
        break;
      default:
    }
  };

  return (
    <div
      ref={stripRef}
      id={TAB_STRIP_ID}
      className="hot-tab-strip"
      style={strip}
      role="tablist"
      aria-label="Open files"
      // Not a Tab stop — focusable only programmatically, so `EditorShell` has
      // somewhere to put focus when the tab that had it was the last one.
      tabIndex={-1}
    >
      {paths.map((path, i) => {
        const isActive = path === active;
        const isDirty = !!dirtyPaths?.has(path);
        return (
          <div
            key={path}
            id={tabId(path)}
            className="hot-tab"
            role="tab"
            aria-selected={isActive}
            aria-controls={tabPanelId(path)}
            // Roving: the strip is one tab stop, and the active tab is the entry point.
            tabIndex={isActive ? 0 : -1}
            data-active={isActive ? "true" : undefined}
            data-dirty={isDirty ? "true" : undefined}
            data-path={path}
            title={path}
            onClick={() => onSelect(path)}
            onKeyDown={onKeyDown(path, i)}
            style={tab(i === 0)}
          >
            <FileIcon path={path} size={TAB_ICON_SIZE} />
            <span style={label(isActive)}>{basename(path)}</span>
            {/* Both glyphs are always mounted and the stylesheet decides which shows.
                Rendering one or the other would swap nodes under the pointer mid-hover. */}
            <button
              type="button"
              className="hot-tab-close"
              style={closeBtn}
              // Part of the roving sequence, not outside it. A native button is
              // focusable by default, so leaving this alone gave the strip one extra
              // Tab stop *per open file* — four open tabs measured five stops where the
              // model calls for two. Keyed to `isActive` for the same reason the tab
              // itself is: the whole strip is one stop, plus the active tab's own ✕.
              tabIndex={isActive ? 0 : -1}
              // The tab carries `title={path}`; the ✕ inherits nothing useful from it.
              aria-label={`Close ${basename(path)}`}
              // A tab is a view, not a buffer — closing discards nothing. The stop is
              // only so the click doesn't also activate the tab it just removed.
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
              // **Only** Enter and Space are swallowed, and only because they mean
              // different things in the two places: on the tab they select it, on the
              // ✕ they close it.
              //
              // Everything else has to bubble to the strip's roving handler. A blanket
              // `stopPropagation` here was harmless while this button was unreachable
              // by keyboard; the moment it became a Tab stop it turned into a dead end
              // — Arrow/Home/End and Delete-to-close all stopped working as soon as you
              // tabbed onto the ✕, with no way out but Tab.
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                onClose(path);
              }}
            >
              <span className="hot-tab-x" style={glyph}>
                <IconX />
              </span>
              <span className="hot-tab-dot" style={{ ...glyph, color: theme.color.accent }}>
                <IconCircleFilled size={DOT_SIZE} />
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The dot reads as a marker, not a glyph — well under the 16px UI icon size. */
const DOT_SIZE = 8;

/** The frames label tabs by filename; the tree is what shows full paths. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

// The bottom hairline is an *inset shadow*, not a border: inset shadows paint
// above the strip's own background but below its children, so an active tab's
// opaque background covers the hairline while transparent inactive tabs let it
// through. That is exactly what the frames show, with no negative margins.
const strip: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  height: 36,
  // `1 1 auto` + `minWidth: 0`, and both halves matter. T4 had `flexShrink: 0` here,
  // correctly for a strip that was always narrower than its bar; with real multi-tab
  // that pins the strip to its content width, so eight tabs make it overflow the
  // editor column instead of scrolling inside it — and `overflowX` never fires,
  // because the box is never smaller than what it holds. `minWidth: 0` is the other
  // half: a flex item's automatic minimum size is its content, which would block the
  // shrink even with `flexShrink: 1`.
  flex: "1 1 auto",
  minWidth: 0,
  // Eight open files do not fit the frames' 625px strip, and no frame shows an
  // overflow treatment. Scroll rather than an overflow menu (decided in DEV-2169):
  // it needs no new surface, and the shell scrolls the activated tab into view.
  // The scrollbar itself is hidden in the global block — a 36px bar has no room
  // for one, and it would sit on top of the inset hairline.
  overflowX: "auto",
  overflowY: "hidden",
  background: theme.color.surfaceSunken,
  boxShadow: `inset 0 -1px 0 ${theme.color.border}`,
};

// No `background` here, deliberately: both fills live in the global block, or the
// inline one would outrank `.hot-tab:hover` (ADR-0026).
const tab = (isFirst: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: 6,
  boxSizing: "border-box",
  // Without this, tabs compress to fit instead of overflowing and the strip never
  // scrolls.
  flexShrink: 0,
  // The frame gives the active tab a #262624 left border — light-mode `text`, a
  // near-black hairline in light mode. Read as a slip; using `border`. The first
  // tab has no left edge to divide (the sidebar toggle beside it is T2).
  borderLeft: isFirst ? "none" : `1px solid ${theme.color.border}`,
  cursor: "pointer",
  whiteSpace: "nowrap",
  // The tab is a div with a roving tabindex, so it gets no UA focus ring of its
  // own; `.hot-tab:focus-visible` in the global block draws one, inset so it is
  // not clipped by the neighbouring tab's border.
  outlineOffset: -2,
});

const label = (isActive: boolean): CSSProperties => ({
  fontFamily: theme.font.ui,
  fontSize: 12,
  lineHeight: "20px",
  color: isActive ? theme.color.text : theme.color.textMuted,
});

// A 16px square, so the ✕ and the 8px dot occupy the same slot and the tab keeps
// its width whichever is showing. No `background` — `.hot-tab-close` in the global
// block owns the resting fill and the hover.
const closeBtn: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  padding: 0,
  border: "none",
  borderRadius: 3,
  color: theme.color.textMuted,
  cursor: "pointer",
};

// `display` is owned by the stylesheet — it is what swaps the two glyphs — so it
// must not appear here, or it would outrank the rule that hides one of them.
const glyph: CSSProperties = {
  alignItems: "center",
  justifyContent: "center",
};
