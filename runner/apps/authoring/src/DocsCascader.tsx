import { useEffect, useMemo, useRef, useState } from "react";
import { theme } from "@handsontable/demo-editor-shell";
import type { DocsManifestItem } from "./docs-catalog.js";

// A Cascader-style example picker (à la Ant Design's Cascader): the ~1,100 docs
// examples are drilled through columns — docs category → guide → example →
// framework — instead of one unusable flat <select>. A search box filters the
// full path. Starter templates are the first top-level branch.

/** One framework option for an example (populates the separate framework picker). */
export interface FrameworkOption {
  framework: string;
  displayName: string;
  docsPath: string;
}

export type CascaderLeaf =
  // A documentation example — framework is chosen separately, not in the tree.
  | { kind: "docsExample"; frameworks: FrameworkOption[] }
  | { kind: "starter"; framework: string };

interface TreeNode {
  key: string;
  label: string;
  children?: TreeNode[];
  leaf?: CascaderLeaf;
  /** Full breadcrumb of labels down to this node (for search + a11y). */
  path: string[];
}

export interface DocsCascaderProps {
  manifestItems: DocsManifestItem[];
  starters: { framework: string; displayName: string }[];
  /** Text shown in the trigger for the current selection. */
  currentLabel: string;
  /** Key of the currently-selected leaf — expanded to and highlighted on open.
   *  Docs example: `${guide}|${exampleId}`. Starter: `starter:${framework}`. */
  selectedKey?: string;
  onSelect: (leaf: CascaderLeaf) => void;
}

function insertLeaf(root: TreeNode[], segments: string[], key: string, label: string, leaf: CascaderLeaf) {
  let level = root;
  let path: string[] = [];
  for (const seg of segments) {
    path = [...path, seg];
    let node = level.find((n) => n.key === seg && n.children);
    if (!node) {
      node = { key: seg, label: seg, children: [], path };
      level.push(node);
    }
    level = node.children!;
  }
  level.push({ key, label, leaf, path: [...path, label] });
}

function buildTree(items: DocsManifestItem[], starters: DocsCascaderProps["starters"]): TreeNode[] {
  const root: TreeNode[] = [];

  // Starter templates first.
  const starterNode: TreeNode = { key: "__starters", label: "Starter templates", children: [], path: ["Starter templates"] };
  for (const s of starters) {
    starterNode.children!.push({
      key: "starter:" + s.framework,
      label: s.displayName,
      leaf: { kind: "starter", framework: s.framework },
      path: ["Starter templates", s.displayName],
    });
  }
  root.push(starterNode);

  // Documentation-guide examples: breadcrumb → example (leaf). Frameworks are
  // grouped onto the example leaf and picked from a separate control.
  const groups = new Map<string, { it: DocsManifestItem; frameworks: FrameworkOption[] }>();
  for (const it of items) {
    const key = it.guide + "|" + it.exampleId;
    let g = groups.get(key);
    if (!g) { g = { it, frameworks: [] }; groups.set(key, g); }
    g.frameworks.push({ framework: it.framework, displayName: it.displayName, docsPath: it.docsPath });
  }
  for (const [key, g] of groups) {
    insertLeaf(root, g.it.breadcrumb, key, g.it.exampleTitle, { kind: "docsExample", frameworks: g.frameworks });
  }
  return root;
}

/** Flatten every leaf with its full path — used for search. */
function collectLeaves(nodes: TreeNode[], acc: { leaf: CascaderLeaf; path: string[] }[] = []) {
  for (const n of nodes) {
    if (n.leaf) acc.push({ leaf: n.leaf, path: n.path });
    if (n.children) collectLeaves(n.children, acc);
  }
  return acc;
}

/** Map each leaf key → the chain of branch *keys* leading to it (for expand-on-open). */
function collectLeafSegments(nodes: TreeNode[], prefix: string[] = [], out = new Map<string, string[]>()) {
  for (const n of nodes) {
    if (n.leaf) out.set(n.key, prefix);
    if (n.children) collectLeafSegments(n.children, [...prefix, n.key], out);
  }
  return out;
}

export function DocsCascader({ manifestItems, starters, currentLabel, selectedKey, onSelect }: DocsCascaderProps) {
  const [open, setOpen] = useState(false);
  const [activePath, setActivePath] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildTree(manifestItems, starters), [manifestItems, starters]);
  const allLeaves = useMemo(() => collectLeaves(tree), [tree]);
  const leafSegments = useMemo(() => collectLeafSegments(tree), [tree]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/);
    const out: { leaf: CascaderLeaf; path: string[] }[] = [];
    for (const l of allLeaves) {
      const hay = l.path.join(" ▸ ").toLowerCase();
      if (terms.every((t) => hay.includes(t))) out.push(l);
      if (out.length >= 200) break;
    }
    return out;
  }, [query, allLeaves]);

  // Columns to render: root, then children along activePath (branches only).
  const columns = useMemo(() => {
    const cols: TreeNode[][] = [tree];
    let level = tree;
    for (const key of activePath) {
      const node = level.find((n) => n.key === key);
      if (!node?.children) break;
      cols.push(node.children);
      level = node.children;
    }
    return cols;
  }, [tree, activePath]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 0);
      // Expand the columns down to the currently-selected leaf.
      const segs = selectedKey ? leafSegments.get(selectedKey) : undefined;
      setActivePath(segs ?? []);
    } else {
      setActivePath([]);
      setQuery("");
    }
  }, [open, selectedKey, leafSegments]);

  // Scroll the highlighted (selected) leaf into view once the columns render.
  useEffect(() => {
    if (open && !query) selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, activePath, query]);

  const choose = (leaf: CascaderLeaf) => {
    onSelect(leaf);
    setOpen(false);
  };

  const expand = (depth: number, node: TreeNode) => {
    if (node.leaf) { choose(node.leaf); return; }
    setActivePath((p) => [...p.slice(0, depth), node.key]);
  };

  return (
    // `flex: 1` so the trigger fills the pill and the pill's search icon stays
    // pinned to its right edge (`72:15865`), not tucked against the label.
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button type="button" style={s.trigger} onClick={() => setOpen((o) => !o)} title={currentLabel}>
        {/* No chevron: `72:15863` has it `hidden`. The pill's search icon is
            the affordance the design gives this trigger. */}
        <span style={s.triggerLabel}>{currentLabel}</span>
      </button>

      {open && (
        <div style={s.pop}>
          <div style={s.searchRow}>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search examples…"
              style={s.search}
              aria-label="Search examples"
            />
          </div>

          {query.trim() ? (
            <div style={s.results}>
              {results.length === 0 && <div style={s.empty}>No matching examples.</div>}
              {results.map((r, i) => (
                <div
                  key={i}
                  className="hot-casc-row"
                  style={s.resultRow}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(r.leaf)}
                >
                  {r.path.map((seg, j) => (
                    <span key={j}>
                      {j > 0 && <span style={{ color: theme.color.textMuted }}> ▸ </span>}
                      <span style={{ color: j === r.path.length - 1 ? theme.color.text : theme.color.textMuted }}>{seg}</span>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div style={s.cols}>
              {columns.map((nodes, depth) => (
                <div key={depth} style={s.col}>
                  {nodes.map((node) => {
                    const active = activePath[depth] === node.key;
                    const isBranch = !!node.children;
                    const selected = !isBranch && !!selectedKey && node.key === selectedKey;
                    return (
                      <div
                        key={node.key}
                        ref={selected ? selectedRef : undefined}
                        className="hot-casc-row"
                        style={{ ...s.item, ...(selected ? s.itemSelected : active ? s.itemActive : null) }}
                        onMouseEnter={() => isBranch && setActivePath((p) => [...p.slice(0, depth), node.key])}
                        onClick={() => expand(depth, node)}
                      >
                        <span style={s.itemLabel}>{node.label}</span>
                        {isBranch && <span style={{ color: theme.color.textMuted, marginLeft: 8 }}>›</span>}
                        {selected && <span style={{ marginLeft: 8 }}>✓</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  // Chrome-less: T2 renders this inside the top bar's example pill
  // (`shellStyles.examplePill`, frame `72:15859`), which draws the one box the
  // design shows. A border/background here would nest a second box inside it.
  trigger: {
    display: "inline-flex", alignItems: "center", flex: 1, minWidth: 0,
    fontFamily: theme.font.ui, fontSize: 13, padding: 0,
    border: "none", background: "transparent", cursor: "pointer", color: theme.color.text,
  },
  triggerLabel: {
    flex: 1, minWidth: 0, textAlign: "left",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  pop: {
    position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 1000,
    background: theme.color.surfaceRaised, border: `1px solid ${theme.color.border}`,
    borderRadius: 10, boxShadow: theme.shadow.popover, overflow: "hidden",
    // `max-content`, not `minWidth`: since T2 the trigger lives inside the top
    // bar's 480px example pill, which is the popover's containing block. Left to
    // shrink-to-fit it would size against that 480 and clip the second column.
    minWidth: 260, width: "max-content",
  },
  searchRow: { padding: 8, borderBottom: `1px solid ${theme.color.border}`, background: theme.color.surfaceMuted },
  search: {
    width: 260, boxSizing: "border-box", fontFamily: theme.font.ui, fontSize: 13,
    padding: "6px 9px", borderRadius: 7, border: `1px solid ${theme.color.border}`,
    background: theme.color.surface, color: theme.color.text, outline: "none",
  },
  cols: { display: "flex", alignItems: "stretch" },
  col: {
    minWidth: 210, maxWidth: 260, maxHeight: 380, overflowY: "auto",
    borderRight: `1px solid ${theme.color.border}`, padding: 4,
  },
  item: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "6px 9px", borderRadius: 6, cursor: "pointer",
    fontFamily: theme.font.ui, fontSize: 12.5, color: theme.color.text,
    whiteSpace: "nowrap",
  },
  itemActive: { background: theme.color.surfaceMuted, fontWeight: 600 },
  itemSelected: { background: theme.color.accent, color: theme.color.accentContrast, fontWeight: 600 },
  itemLabel: { overflow: "hidden", textOverflow: "ellipsis" },
  results: { maxHeight: 400, overflowY: "auto", padding: 4, minWidth: 420 },
  resultRow: {
    padding: "6px 9px", borderRadius: 6, cursor: "pointer",
    fontFamily: theme.font.ui, fontSize: 12.5, whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis",
  },
  empty: { padding: "10px 12px", color: theme.color.textMuted, fontFamily: theme.font.ui, fontSize: 12.5 },
};
