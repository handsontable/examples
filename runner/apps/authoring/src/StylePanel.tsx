// "Style this demo" — the theme panel (DEV-2047).
//
// The same job theme-builder does, against the example you have open instead
// of against a fixed demo grid: pick the preset stack (tokens / colors / icons
// / colour scheme / density), then override individual tokens on top.
//
// The important difference from theme-builder is where the result goes. There,
// a theme is app state you copy out at the end. Here it is written into the
// example as a real stylesheet, so it survives Download, Share and reload, and
// it lands in the running preview through the same file-write path the editor
// uses. Styling a demo is editing the demo.

import { useMemo, useState } from "react";
import { theme as ui } from "@handsontable/demo-editor-shell";
import type { FilesMap } from "@handsontable/demo-runtime";
import {
  buildResetChanges,
  buildThemeChanges,
  buildThemeSnippet,
  manualImportHint,
  THEME_CSS_PATH,
} from "./theme/codegen.js";
import {
  ALL_TOKENS,
  COLORS_PRESETS,
  COLOR_SCHEMES,
  DEFAULT_THEME,
  DENSITY_VARIANTS,
  ICONS_PRESETS,
  isPristine,
  TOKEN_GROUPS,
  TOKENS_PRESETS,
  type ThemeState,
  type TokenDef,
} from "./theme/vocabulary.js";

export interface StylePanelProps {
  getFiles: () => FilesMap;
  /** Write a file into the editor + running preview. */
  applyEdit: (path: string, contents: string) => void;
  onClose: () => void;
}

export function StylePanel({ getFiles, applyEdit, onClose }: StylePanelProps) {
  const [state, setState] = useState<ThemeState>(DEFAULT_THEME);
  const [openGroup, setOpenGroup] = useState<string>(TOKEN_GROUPS[0]?.title ?? "");
  const [showCode, setShowCode] = useState(false);
  const [applied, setApplied] = useState<{ linked: boolean } | null>(null);

  const snippet = useMemo(() => buildThemeSnippet(state), [state]);
  const pristine = isPristine(state);

  /** Write the theme into the demo. Every change goes through the editor's own
   *  applyEdit, so the file shows up in the file tree and in a download. */
  function apply(next: ThemeState) {
    const { changes, linked } = buildThemeChanges(getFiles(), next);
    for (const change of changes) applyEdit(change.path, change.contents);
    setApplied({ linked });
  }

  function update(patch: Partial<ThemeState>) {
    const next = { ...state, ...patch };
    setState(next);
    apply(next);
  }

  function setParam(name: string, value: string) {
    const params = { ...state.params };
    if (value.trim()) params[name] = value;
    else delete params[name];
    update({ params });
  }

  function reset() {
    for (const change of buildResetChanges(getFiles())) applyEdit(change.path, change.contents);
    setState(DEFAULT_THEME);
    setApplied(null);
  }

  return (
    <aside style={panel} aria-label="Style this demo">
      <header style={head}>
        <strong style={{ fontFamily: ui.font.ui, fontSize: 14 }}>Style this demo</strong>
        <button style={closeBtn} onClick={onClose} aria-label="Close styling panel">✕</button>
      </header>

      <div style={body}>
        <p style={note}>
          The same theme controls as{" "}
          <a href="https://theme-builder.handsontable.com/" target="_blank" rel="noreferrer" style={{ color: ui.color.accent }}>
            Theme Builder
          </a>
          , applied to the example you have open. Changes are written to{" "}
          <code style={code}>{THEME_CSS_PATH}</code> in the demo, so they travel with a download or a share.
        </p>

        <Section title="Preset">
          <Select
            label="Tokens"
            value={state.tokens}
            options={TOKENS_PRESETS}
            onChange={(v) => update({ tokens: v as ThemeState["tokens"] })}
          />
          <Select
            label="Colors"
            value={state.colors}
            options={COLORS_PRESETS}
            onChange={(v) => update({ colors: v as ThemeState["colors"] })}
          />
          <Select
            label="Icons"
            value={state.icons}
            options={ICONS_PRESETS}
            onChange={(v) => update({ icons: v as ThemeState["icons"] })}
          />
          <Select
            label="Colour scheme"
            value={state.colorScheme}
            options={COLOR_SCHEMES}
            onChange={(v) => update({ colorScheme: v as ThemeState["colorScheme"] })}
          />
          <Select
            label="Density"
            value={state.density}
            options={DENSITY_VARIANTS}
            onChange={(v) => update({ density: v as ThemeState["density"] })}
          />
        </Section>

        {TOKEN_GROUPS.map((group) => {
          const open = openGroup === group.title;
          const set = group.tokens.filter((t) => state.params[t.name]).length;
          return (
            <section key={group.title} style={{ borderTop: `1px solid ${ui.color.border}` }}>
              <button
                type="button"
                style={groupHeader}
                onClick={() => setOpenGroup(open ? "" : group.title)}
                aria-expanded={open}
              >
                <span>{open ? "▾" : "▸"} {group.title}</span>
                {set > 0 && <span style={badge}>{set}</span>}
              </button>
              {open && (
                <div style={{ padding: "0 14px 12px" }}>
                  {group.tokens.map((token) => (
                    <TokenField
                      key={token.name}
                      token={token}
                      value={state.params[token.name] ?? ""}
                      onChange={(v) => setParam(token.name, v)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <footer style={foot}>
        {applied && !applied.linked && (
          <p style={{ ...note, marginTop: 0 }}>
            This example has no HTML entry to link the stylesheet from, so add this one line to its
            entry file: <code style={code}>{manualImportHint(state)}</code>
          </p>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={ghost} onClick={() => setShowCode((v) => !v)}>
            {showCode ? "Hide code" : "Copy for my app"}
          </button>
          <button type="button" style={ghost} onClick={reset} disabled={pristine}>
            Reset
          </button>
          {applied && <span style={{ fontSize: 11.5, color: "#1a8f5a", alignSelf: "center" }}>Applied to the preview</span>}
        </div>
        {showCode && (
          <>
            <p style={{ ...note, marginBottom: 4 }}>
              In a real application, register the theme rather than overriding CSS:
            </p>
            <pre style={pre}><code>{snippet}</code></pre>
            <button
              type="button"
              style={ghost}
              onClick={() => void navigator.clipboard?.writeText(snippet)}
            >
              Copy snippet
            </button>
          </>
        )}
      </footer>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: "10px 14px 12px" }}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </section>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label style={row}>
      <span style={rowLabel}>{label}</span>
      <select style={control} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>{o[0]!.toUpperCase() + o.slice(1)}</option>
        ))}
      </select>
    </label>
  );
}

/** One token. Colours get a swatch beside the text box, because a hex field
 *  alone makes choosing a colour a guessing game — but the text box stays, so
 *  `transparent`, a CSS variable or an rgba() are all still expressible. */
function TokenField({
  token,
  value,
  onChange,
}: {
  token: TokenDef;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={row}>
        <span style={rowLabel} title={token.name}>{token.label}</span>
        <span style={{ display: "flex", gap: 4, flex: 1 }}>
          {token.kind === "color" && (
            <input
              type="color"
              aria-label={`${token.label} colour picker`}
              value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
              onChange={(e) => onChange(e.target.value)}
              style={swatch}
            />
          )}
          <input
            type="text"
            value={value}
            placeholder="theme default"
            onChange={(e) => onChange(e.target.value)}
            style={control}
          />
        </span>
      </label>
      {token.hint && <div style={hint}>{token.hint}</div>}
    </div>
  );
}

/** Exported for the toolbar so the button and the panel stay together. */
export function StyleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      style={styleBtn}
      onClick={onToggle}
      aria-pressed={open}
      title="Restyle this example with the Theme Builder controls — presets, colours, density and per-token overrides"
    >
      🎨 Style
    </button>
  );
}

export const STYLE_PANEL_TOKENS = ALL_TOKENS.length;

// ---- Styles ------------------------------------------------------------------

const panel: React.CSSProperties = {
  position: "fixed", top: 0, right: 0, height: "100%", width: 380, maxWidth: "95vw",
  background: "#fff", borderLeft: `1px solid ${ui.color.border}`,
  boxShadow: "-8px 0 24px rgba(0,0,0,0.08)", zIndex: 900,
  display: "flex", flexDirection: "column", fontFamily: ui.font.ui, color: ui.color.text,
};
const head: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 14px", borderBottom: `1px solid ${ui.color.border}`,
};
const body: React.CSSProperties = { flex: 1, overflowY: "auto" };
const foot: React.CSSProperties = {
  borderTop: `1px solid ${ui.color.border}`, padding: "10px 14px", background: ui.color.surfaceMuted,
};
const closeBtn: React.CSSProperties = {
  border: "none", background: "none", cursor: "pointer", fontSize: 16, color: ui.color.textMuted,
};
const sectionTitle: React.CSSProperties = {
  fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4,
  color: ui.color.textMuted, fontWeight: 600, marginBottom: 8,
};
const groupHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
  background: "none", border: "none", cursor: "pointer", padding: "10px 14px",
  fontFamily: ui.font.ui, fontSize: 13, color: ui.color.text, textAlign: "left",
};
const badge: React.CSSProperties = {
  background: ui.color.accent, color: "#fff", borderRadius: 999,
  fontSize: 10.5, padding: "1px 6px", fontWeight: 600,
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 };
const rowLabel: React.CSSProperties = { width: 130, flex: "0 0 130px", fontSize: 12.5 };
const control: React.CSSProperties = {
  flex: 1, minWidth: 0, fontFamily: ui.font.ui, fontSize: 12.5, padding: "4px 6px",
  border: `1px solid ${ui.color.border}`, borderRadius: 6, color: ui.color.text, background: "#fff",
};
const swatch: React.CSSProperties = {
  width: 30, flex: "0 0 30px", padding: 0, height: 26,
  border: `1px solid ${ui.color.border}`, borderRadius: 6, background: "#fff", cursor: "pointer",
};
const hint: React.CSSProperties = { fontSize: 11, color: ui.color.textMuted, marginLeft: 138 };
const note: React.CSSProperties = { fontSize: 11.5, color: ui.color.textMuted, margin: "0 0 10px" };
const code: React.CSSProperties = {
  fontFamily: ui.font.mono, fontSize: "0.92em", background: "#fff",
  border: `1px solid ${ui.color.border}`, borderRadius: 4, padding: "0 4px",
};
const pre: React.CSSProperties = {
  background: ui.color.editorBg, color: ui.color.editorText, borderRadius: ui.radius.md,
  padding: 10, overflowX: "auto", fontFamily: ui.font.mono, fontSize: 11, margin: "0 0 8px",
  maxHeight: 220,
};
const ghost: React.CSSProperties = {
  fontFamily: ui.font.ui, fontSize: 12.5, background: "#fff", color: ui.color.text,
  border: `1px solid ${ui.color.border}`, borderRadius: 6, padding: "5px 11px", cursor: "pointer",
};
const styleBtn: React.CSSProperties = {
  fontFamily: ui.font.ui, fontSize: 12.5, background: "#fff", color: ui.color.text,
  border: `1px solid ${ui.color.border}`, borderRadius: 6, padding: "5px 11px",
  cursor: "pointer", whiteSpace: "nowrap",
};
