import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  headerLabel,
  IconChevronDown,
  IconChevronRight,
  IconSearch,
  theme,
} from "@handsontable/demo-editor-shell";
import {
  buildPickerModel,
  searchLeaves,
  STARTERS_CATEGORY_KEY,
  type DocsManifestItem,
  type PickerCategory,
  type PickerLeaf,
  type PickerLeafRef,
} from "./docs-catalog.js";

// The example picker (`72:17078`, popover `72:18028`): ~1,450 docs examples plus
// the starter templates, in a fixed two-column popover the width of the top bar's
// example pill. Left column — categories, grouped under `DOCUMENTATION` and
// `RECIPES` labels. Right column — that category's examples under collapsible
// section headers. A search box flattens the whole thing into one filtered list.
//
// Deliberately *not* the old depth-driven column stack: the model in
// `docs-catalog.ts` promotes Recipes' sub-categories into the left column, which
// is what lets every category resolve to exactly one level of section headers and
// keeps the popover at the pill's 480px instead of growing a third column.

export type { PickerLeaf as CascaderLeaf, FrameworkOption } from "./docs-catalog.js";

export interface DocsCascaderProps {
  manifestItems: DocsManifestItem[];
  starters: { framework: string; displayName: string }[];
  /** Text shown in the trigger for the current selection. */
  currentLabel: string;
  /** Key of the currently-selected leaf — revealed and highlighted on open.
   *  Docs example: `${guide}|${exampleId}`. Starter: `starter:${framework}`. */
  selectedKey?: string;
  onSelect: (leaf: PickerLeaf) => void;
}

/** Which column holds keyboard focus. `null` focus means the search input does. */
type FocusCol = "cat" | "ex" | "results";
interface Focus {
  col: FocusCol;
  idx: number;
}

/** A navigable row in the example column — a collapsible header or a leaf. */
type ExRow =
  | { kind: "header"; key: string; collapsed: boolean }
  | { kind: "item"; key: string; leaf: PickerLeaf };

export function DocsCascader({
  manifestItems,
  starters,
  currentLabel,
  selectedKey,
  onSelect,
}: DocsCascaderProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<string>(STARTERS_CATEGORY_KEY);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [focus, setFocus] = useState<Focus | null>(null);
  // Bumped only by explicit keyboard navigation. Hovering a category rewrites the
  // example column but must not yank focus, so the focus-moving effect keys off
  // this counter rather than off `focus` itself.
  const [focusSeq, setFocusSeq] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const model = useMemo(() => buildPickerModel(manifestItems, starters), [manifestItems, starters]);
  const results = useMemo(() => searchLeaves(model, query), [model, query]);
  const searching = query.trim().length > 0;

  /** Every category in render order — the left column's navigable rows. */
  const catRows = useMemo(() => model.sections.flatMap((sec) => sec.categories), [model]);

  const activeCategory: PickerCategory | undefined = useMemo(
    () => catRows.find((c) => c.key === activeCat) ?? catRows[0],
    [catRows, activeCat],
  );

  /** The example column flattened for arrow-key walking — a collapsed group
   *  contributes its header and none of its items. */
  const exRows = useMemo<ExRow[]>(() => {
    if (!activeCategory) return [];
    const out: ExRow[] = [];
    for (const g of activeCategory.groups) {
      const isCollapsed = collapsed.has(g.key);
      if (g.header) out.push({ kind: "header", key: g.key, collapsed: isCollapsed });
      if (isCollapsed) continue;
      for (const it of g.items) out.push({ kind: "item", key: it.key, leaf: it.leaf });
    }
    return out;
  }, [activeCategory, collapsed]);

  // ---- dismissal ---------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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

  // ---- open / close ------------------------------------------------------
  // Read through a ref so the effect below can depend on `open` alone. `App`
  // rebuilds the `starters` array on every render (`App.tsx:941`), which gives
  // `model` a fresh identity each time; as effect deps those would re-run this
  // on every parent render while the popover is open — snapping the category
  // column back and pulling focus off the row a keyboard user is walking.
  const reveal = useRef({ selectedKey, model });
  reveal.current = { selectedKey, model };

  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 0);
      // Reveal the current selection: switch to its category and force its group
      // open, so the highlighted row is actually on screen.
      const { selectedKey: key, model: m } = reveal.current;
      const at = key ? m.locate.get(key) : undefined;
      setActiveCat(at?.categoryKey ?? STARTERS_CATEGORY_KEY);
      setCollapsed((prev) => {
        if (!at || !prev.has(at.groupKey)) return prev;
        const next = new Set(prev);
        next.delete(at.groupKey);
        return next;
      });
    } else {
      setQuery("");
      setCollapsed(new Set<string>());
      setFocus(null);
    }
  }, [open]);

  // Scroll the highlighted row into view once the columns have rendered.
  useEffect(() => {
    if (open && !searching) selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, activeCat, searching]);

  // Move real DOM focus to the row the keyboard walked to.
  useEffect(() => {
    if (!focus) return;
    const el = rowRefs.current.get(`${focus.col}:${focus.idx}`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
    // Intentionally keyed on the nonce alone — see `focusSeq`.

  }, [focusSeq]);

  const choose = useCallback(
    (leaf: PickerLeaf) => {
      onSelect(leaf);
      setOpen(false);
    },
    [onSelect],
  );

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  /** Focus a row by column + index, clamped to that column's length. */
  const moveFocus = useCallback((col: FocusCol, idx: number, len: number) => {
    if (len <= 0) return;
    setFocus({ col, idx: Math.max(0, Math.min(idx, len - 1)) });
    setFocusSeq((n) => n + 1);
  }, []);

  const focusSearch = useCallback(() => {
    setFocus(null);
    searchRef.current?.focus();
  }, []);

  const setRowRef = (col: FocusCol, idx: number) => (el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(`${col}:${idx}`, el);
    else rowRefs.current.delete(`${col}:${idx}`);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    if (searching) moveFocus("results", 0, results.length);
    else moveFocus("cat", Math.max(0, catRows.findIndex((c) => c.key === activeCat)), catRows.length);
  };

  const onCatKeyDown = (e: React.KeyboardEvent, idx: number, cat: PickerCategory) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus("cat", idx + 1, catRows.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (idx === 0) focusSearch();
        else moveFocus("cat", idx - 1, catRows.length);
        break;
      case "ArrowRight":
      case "Enter":
      case " ": {
        e.preventDefault();
        setActiveCat(cat.key);
        // Length isn't known until the example column re-renders from the new
        // category; index 0 always exists if the category has any rows at all.
        const len = cat.groups.reduce((n, g) => n + (g.header ? 1 : 0) + g.items.length, 0);
        moveFocus("ex", 0, len);
        break;
      }
    }
  };

  const onExKeyDown = (e: React.KeyboardEvent, idx: number, row: ExRow) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus("ex", idx + 1, exRows.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (idx === 0) focusSearch();
        else moveFocus("ex", idx - 1, exRows.length);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveFocus("cat", catRows.findIndex((c) => c.key === activeCategory?.key), catRows.length);
        break;
      case "ArrowRight":
        if (row.kind === "header" && row.collapsed) {
          e.preventDefault();
          toggleGroup(row.key);
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (row.kind === "header") toggleGroup(row.key);
        else choose(row.leaf);
        break;
    }
  };

  const onResultKeyDown = (e: React.KeyboardEvent, idx: number, r: PickerLeafRef) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus("results", idx + 1, results.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (idx === 0) focusSearch();
        else moveFocus("results", idx - 1, results.length);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(r.leaf);
        break;
    }
  };

  /** Roving tabindex: exactly one row per column is tabbable at a time. */
  const tabIndexFor = (col: FocusCol, idx: number) =>
    (focus?.col === col ? focus.idx === idx : idx === 0) ? 0 : -1;

  // Running index across the example column, so headers and items share one
  // arrow-key sequence. Reset each render, consumed in DOM order below.
  let exIdx = -1;

  return (
    // `flex: 1` so the trigger fills the top bar's example pill and the search
    // icon stays pinned to its right edge (`72:15865`), not tucked against the
    // label.
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button
        type="button"
        style={s.trigger}
        onClick={() => setOpen((o) => !o)}
        title={currentLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {/* No chevron: `72:15863` has it `hidden`, and the search icon is the
            affordance the design gives this trigger instead. It lives *inside*
            the button — as a sibling it looked like the opener without being
            one, since only the label area would have toggled the menu. */}
        <span style={s.triggerLabel}>{currentLabel}</span>
        <IconSearch />
      </button>

      {open && (
        <div style={s.pop} role="dialog" aria-label="Choose an example">
          <div style={s.searchWrap}>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search examples…"
              style={s.search}
              aria-label="Search examples"
            />
            <span style={s.searchIcon}>
              <IconSearch />
            </span>
          </div>

          {searching ? (
            <div style={s.results} role="listbox" aria-label="Search results">
              {results.length === 0 && <div style={s.empty}>No matching examples.</div>}
              {results.map((r, i) => (
                <div
                  key={r.key}
                  ref={setRowRef("results", i)}
                  className="hot-casc-row"
                  style={s.resultRow}
                  role="option"
                  aria-selected={r.key === selectedKey}
                  tabIndex={tabIndexFor("results", i)}
                  onKeyDown={(e) => onResultKeyDown(e, i, r)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r.leaf)}
                >
                  {r.path.map((seg, j) => (
                    <span key={j}>
                      {j > 0 && <span style={s.sep}> ▸ </span>}
                      <span style={j === r.path.length - 1 ? undefined : s.sep}>{seg}</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div style={s.body}>
              <div style={s.catCol} role="listbox" aria-label="Categories">
                {model.sections.map((sec, si) => (
                  <div
                    key={sec.label ?? "__top"}
                    role="group"
                    aria-label={sec.label ?? "Starter templates"}
                  >
                    {/* The visible label duplicates the group's accessible name,
                        so it is hidden rather than announced twice. */}
                    {sec.label && (
                      <div style={si === 0 ? s.sectionLabel : s.sectionLabelSpaced} aria-hidden="true">
                        {sec.label}
                      </div>
                    )}
                    {sec.categories.map((cat) => {
                      const idx = catRows.indexOf(cat);
                      const active = cat.key === activeCategory?.key;
                      return (
                        <div
                          key={cat.key}
                          ref={setRowRef("cat", idx)}
                          className="hot-casc-row"
                          style={active ? { ...s.catRow, ...s.catRowActive } : s.catRow}
                          role="option"
                          aria-selected={active}
                          tabIndex={tabIndexFor("cat", idx)}
                          onKeyDown={(e) => onCatKeyDown(e, idx, cat)}
                          onMouseEnter={() => setActiveCat(cat.key)}
                          onClick={() => setActiveCat(cat.key)}
                        >
                          <span style={s.rowLabel} title={cat.label}>{cat.label}</span>
                          <span style={s.chevron}><IconChevronRight /></span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* A tree, not a listbox: the section headers are expandable nodes,
                  which `role="listbox"` has no valid content model for. */}
              <div style={s.exCol} role="tree" aria-label="Examples">
                {activeCategory?.groups.map((g) => {
                  const isCollapsed = collapsed.has(g.key);
                  const headerIdx = g.header ? ++exIdx : -1;
                  return (
                    <div key={g.key} style={s.group}>
                      {g.header && (
                        <div
                          ref={setRowRef("ex", headerIdx)}
                          className="hot-casc-header"
                          style={s.groupHeader}
                          role="treeitem"
                          aria-expanded={!isCollapsed}
                          aria-label={g.header}
                          tabIndex={tabIndexFor("ex", headerIdx)}
                          onKeyDown={(e) =>
                            onExKeyDown(e, headerIdx, { kind: "header", key: g.key, collapsed: isCollapsed })
                          }
                          onClick={() => toggleGroup(g.key)}
                        >
                          <span style={s.groupHeaderLabel}>{g.header}</span>
                          <span style={s.chevron}>
                            {isCollapsed ? <IconChevronRight /> : <IconChevronDown />}
                          </span>
                        </div>
                      )}
                      {!isCollapsed && (
                        // A headerless group takes no name of its own: the tree
                        // already carries one, and naming it after the category
                        // would collide with the left column's section group.
                        <div role="group" aria-label={g.header || undefined}>
                          {g.items.map((it) => {
                            const idx = ++exIdx;
                            const selected = it.key === selectedKey;
                            return (
                              <div
                                key={it.key}
                                ref={(el) => {
                                  setRowRef("ex", idx)(el);
                                  if (selected) selectedRef.current = el;
                                }}
                                className="hot-casc-row"
                                style={selected ? { ...s.exItem, ...s.exItemSelected } : s.exItem}
                                role="treeitem"
                                aria-selected={selected}
                                tabIndex={tabIndexFor("ex", idx)}
                                onKeyDown={(e) =>
                                  onExKeyDown(e, idx, { kind: "item", key: it.key, leaf: it.leaf })
                                }
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => choose(it.leaf)}
                              >
                                <span style={s.rowLabel} title={it.label}>{it.label}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Design geometry (`72:18028`): a 480-wide popover — exactly the pill's width —
// with an 8px inset, a 179px category column, a 10px gutter, and the example
// column taking the rest. The body caps at 512 and each column scrolls on its
// own: the live `next` manifest yields 16 documentation categories + 12 Recipes
// sub-categories + starters, well past what 512px shows at 32px a row.
const CAT_COL_WIDTH = 179;
const BODY_MAX_HEIGHT = 512;

const s = {
  // Chrome-less: T2 renders this inside the top bar's example pill
  // (`shellStyles.examplePill`, frame `72:15859`), which draws the one box the
  // design shows. A border/background here would nest a second box inside it.
  trigger: {
    // `width: 100%`, not `flex: 1` — the wrapper is a positioned block (it is the
    // popover's containing block), so a flex value on this button would do
    // nothing and the search icon would sit tucked against the label instead of
    // at the pill's right edge.
    display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0,
    fontFamily: theme.font.ui, fontSize: 13, padding: 0,
    border: "none", background: "transparent", cursor: "pointer", color: theme.color.text,
  },
  triggerLabel: {
    flex: 1, minWidth: 0, textAlign: "left",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  pop: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 1000,
    // `100%`, not the `max-content` this carried since T2: the design sizes the
    // popover *to* the pill, so the pill being its containing block — the thing
    // that used to clip a wider popover — is now exactly what is wanted.
    width: "100%", boxSizing: "border-box",
    display: "flex", flexDirection: "column", gap: 10,
    padding: theme.space(2),
    background: theme.color.surfaceRaised,
    border: `1px solid ${theme.color.border}`,
    borderRadius: theme.radius.md,
    boxShadow: theme.shadow.popover,
  },

  searchWrap: { position: "relative", display: "flex", alignItems: "center", flex: "0 0 auto" },
  search: {
    width: "100%", height: 36, boxSizing: "border-box",
    padding: `0 ${theme.space(9)} 0 ${theme.space(3)}`,
    fontFamily: theme.font.ui, fontSize: 13,
    borderRadius: theme.radius.md, border: `1px solid ${theme.color.border}`,
    background: theme.color.surface, color: theme.color.text, outline: "none",
  },
  searchIcon: {
    position: "absolute", right: theme.space(3), display: "flex",
    color: theme.color.textMuted, pointerEvents: "none",
  },

  body: { display: "flex", gap: 10, alignItems: "stretch", maxHeight: BODY_MAX_HEIGHT, minHeight: 0 },
  // `scrollbarWidth: thin` claws back most of the ~15px a classic scrollbar
  // takes out of the 179 (Windows/Linux always; macOS when "always show
  // scrollbars" is on). The design draws no scrollbar at all because it shows 16
  // categories — the live manifest has 28 — so some loss is unavoidable here;
  // every row carries a `title` with its full label. Logged as open item 22.
  catCol: { flex: `0 0 ${CAT_COL_WIDTH}px`, minWidth: 0, overflowY: "auto", scrollbarWidth: "thin" },
  exCol: { flex: 1, minWidth: 0, overflowY: "auto" },

  sectionLabel: { ...headerLabel, display: "block", padding: `0 ${theme.space(2)}` },
  sectionLabelSpaced: {
    ...headerLabel, display: "block", padding: `0 ${theme.space(2)}`, marginTop: theme.space(2),
  },

  catRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: theme.space(2),
    height: 32, padding: `0 ${theme.space(2)}`, borderRadius: theme.radius.sm, cursor: "pointer",
    fontFamily: theme.font.ui, fontSize: 13, color: theme.color.text, outlineOffset: -2,
  },
  // `accentSoft` + weight, matching `shellStyles.menuItem(true)` — the treatment
  // the already-shipped version and framework menus give their current row.
  catRowActive: { background: theme.color.accentSoft, fontWeight: 600 },

  group: { marginBottom: theme.space(3) },
  groupHeader: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: theme.space(2),
    height: 20, padding: `0 ${theme.space(3)}`, cursor: "pointer",
    borderRadius: theme.radius.sm, outlineOffset: -2,
  },
  groupHeaderLabel: {
    ...headerLabel, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },

  exItem: {
    display: "flex", alignItems: "center", height: 26, padding: `0 ${theme.space(3)}`,
    borderRadius: theme.radius.sm, cursor: "pointer",
    fontFamily: theme.font.ui, fontSize: 13, color: theme.color.text, outlineOffset: -2,
  },
  exItemSelected: { background: theme.color.accentSoft, fontWeight: 600 },

  // The example column is ~275px, so labels like "Dynamic messages based on
  // source" clip; every row carries a `title` with the full text.
  rowLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  chevron: { display: "flex", flexShrink: 0, color: theme.color.textMuted },

  results: { overflowY: "auto", maxHeight: BODY_MAX_HEIGHT },
  resultRow: {
    padding: `6px ${theme.space(3)}`, borderRadius: theme.radius.sm, cursor: "pointer",
    fontFamily: theme.font.ui, fontSize: 13, color: theme.color.text,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", outlineOffset: -2,
  },
  sep: { color: theme.color.textMuted },
  empty: {
    padding: `10px ${theme.space(3)}`, color: theme.color.textMuted,
    fontFamily: theme.font.ui, fontSize: 13,
  },
} satisfies Record<string, React.CSSProperties>;
