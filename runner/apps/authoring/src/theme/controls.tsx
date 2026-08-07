// Typed token controls (DEV-2199), ported from theme-builder's
// `panel/tabs/components/TokenItem.tsx` and its `inputs/` folder.
//
// One control per token `type`, because a free-text box is the wrong tool for
// nearly all of them: 196 of the 272 tokens are colours, 65 are sizes that
// normally point at the density or sizing scale, and the three `select` tokens
// have a fixed option list. Each row shows the token's label and description,
// the value it *resolves* to, and a Reset that only appears once you've
// overridden it.
//
// Adaptation: theme-builder builds these out of antd (Popover, Segmented,
// ColorPicker, InputNumber). The runner has no component library, so the
// pickers are inline disclosures rather than floating popovers — which also
// behaves better in a 420px side panel than anything that needs positioning.

import { useState } from "react";
import { theme as ui } from "@handsontable/demo-editor-shell";
import type { ColorsMap, TokenMap } from "./presets.js";
import { COMMON_COLORS_KEYS, SIZING } from "./presets.js";
import {
  mergeForColorScheme,
  resolveTokenValue,
  swatchColor,
  tokenValueLabel,
} from "./resolve.js";
import type { ColorScheme, Token, TokenValue } from "./vocabulary.js";

export interface ControlContext {
  /** Preset tokens with the panel's overrides layered on. */
  tokens: TokenMap;
  colors: ColorsMap;
  density: Record<string, string>;
  colorScheme: ColorScheme;
}

export interface TokenControlProps {
  token: Token;
  ctx: ControlContext;
  /** The raw override, if this token has one. */
  value: TokenValue | undefined;
  onChange: (value: TokenValue) => void;
  onReset: () => void;
}

/** Label, description, the control, and a Reset that appears only when the
 *  token is actually overridden. */
function Row({
  token,
  overridden,
  onReset,
  children,
}: {
  token: Token;
  overridden: boolean;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={rowWrap}>
      <div style={rowHead}>
        <span style={rowLabel} title={token.key}>{token.label}</span>
        {overridden && (
          <button type="button" style={resetBtn} onClick={onReset} title={`Reset ${token.key}`}>
            Reset
          </button>
        )}
      </div>
      {children}
      {token.description && <div style={hint}>{token.description}</div>}
    </div>
  );
}

/** `select` — a dropdown from the token's own options. */
function SelectControl({ token, value, resolved, onChange }: {
  token: Token; value: TokenValue | undefined; resolved: string; onChange: (v: string) => void;
}) {
  const current = typeof value === "string" ? value : resolved;
  return (
    <select style={control} value={current} onChange={(e) => onChange(e.target.value)}>
      {!token.options?.some((o) => o.value === current) && <option value={current}>{current || "theme default"}</option>}
      {token.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** `numeric` — a stepper carrying the token's own unit, step, min and max. */
function UnitControl({ token, resolved, onChange }: {
  token: Token; resolved: string; onChange: (v: string) => void;
}) {
  const unit = token.params?.unit ?? "";
  const numeric = resolved.replace(unit, "").trim();
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input
        type="number"
        style={{ ...control, width: 96 }}
        value={numeric}
        step={token.params?.step ?? "1"}
        min={token.params?.min}
        max={token.params?.max}
        // An emptied field means "no override", so send an empty string rather
        // than a bare unit: `"%"` is not empty, so it would be stored and
        // emitted as a value the grid cannot use.
        onChange={(e) => onChange(e.target.value === "" ? "" : `${e.target.value}${unit}`)}
      />
      {unit && <span style={unitTag}>{unit}</span>}
    </span>
  );
}

/**
 * `size` — pick from the sizing scale, follow a density slot, or type a value.
 *
 * The density option is the interesting one: a token set to `density.cellHorizontal`
 * keeps tracking the density preset, so switching compact/comfortable still moves it.
 */
function SizeControl({ value, resolved, density, onChange }: {
  value: TokenValue | undefined;
  resolved: string;
  density: Record<string, string>;
  onChange: (v: string) => void;
}) {
  const raw = typeof value === "string" ? value : "";
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"sizing" | "density" | "custom">(
    raw.startsWith("sizing.") ? "sizing" : raw.startsWith("density.") ? "density" : "custom",
  );

  return (
    <div>
      <button type="button" style={trigger} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{resolved || "theme default"}</span>
        <span style={{ opacity: 0.6 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div style={popover}>
          <div style={segmented}>
            {(["sizing", "density", "custom"] as const).map((m) => (
              <button key={m} type="button" style={segment(mode === m)} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
          {mode === "sizing" && (
            <div style={scrollList}>
              {Object.entries(SIZING)
                .sort((a, b) => parseInt(a[1], 10) - parseInt(b[1], 10))
                .map(([k, v]) => (
                  <button key={k} type="button" style={listItem(raw === `sizing.${k}`)}
                    onClick={() => onChange(`sizing.${k}`)}>
                    <span>{k}</span><span style={{ opacity: 0.6 }}>{v}</span>
                  </button>
                ))}
            </div>
          )}
          {mode === "density" && (
            <div style={scrollList}>
              {Object.keys(density).map((k) => (
                <button key={k} type="button" style={listItem(raw === `density.${k}`)}
                  onClick={() => onChange(`density.${k}`)}>
                  <span>{k.replace(/([A-Z])/g, " $1").replace(/^\w/, (c) => c.toUpperCase())}</span>
                  <span style={{ opacity: 0.6 }}>{density[k]}</span>
                </button>
              ))}
            </div>
          )}
          {mode === "custom" && (
            <input type="text" style={{ ...control, width: "100%" }} defaultValue={raw.includes("px") ? raw : ""}
              placeholder="e.g. 12px" onBlur={(e) => e.target.value && onChange(e.target.value)} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * `color` — the common palette, the ramps, or a raw colour.
 *
 * Two things this does that a plain hex box cannot. Picking a *common* colour
 * writes a `tokens.accentColor` reference, so the token inherits that colour's
 * light and dark variants together. Picking anything else writes only the half
 * of the `[light, dark]` pair matching the scheme you're looking at, so styling
 * in light mode doesn't quietly rewrite dark mode.
 */
function ColorControl({ token, value, ctx, resolved, onChange }: {
  token: Token;
  value: TokenValue | undefined;
  ctx: ControlContext;
  resolved: string;
  onChange: (v: TokenValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const { colors, tokens, colorScheme } = ctx;
  const effective = value ?? tokens[token.key];
  const currentRef = Array.isArray(effective)
    ? String(effective[colorScheme === "light" ? 0 : 1])
    : typeof effective === "string" ? effective : "";

  const pick = (next: string) => onChange(mergeForColorScheme(effective, next, colorScheme));
  const ramp = (name: string) =>
    Object.entries((colors[name] ?? {}) as Record<string, string>);
  const base = Object.entries(colors).filter(([k, v]) => typeof v === "string") as [string, string][];

  return (
    <div>
      <button type="button" style={trigger} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ ...swatch, background: resolved || "transparent" }} />
          <span style={ellipsis}>{tokenValueLabel(effective, colorScheme) || "theme default"}</span>
        </span>
        <span style={{ opacity: 0.6 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div style={popover}>
          {!COMMON_COLORS_KEYS.includes(token.key as (typeof COMMON_COLORS_KEYS)[number]) && (
            <>
              <div style={groupLabel}>Common — brings its own light &amp; dark</div>
              <div style={swatchRow}>
                {COMMON_COLORS_KEYS.map((key) => (
                  <button key={key} type="button" title={key}
                    style={swatchBtn(currentRef === `tokens.${key}`)}
                    onClick={() => onChange(`tokens.${key}`)}>
                    <span style={{
                      ...swatch,
                      background: String(resolveTokenValue(
                        tokens[key], colors, tokens, ctx.density, colorScheme) ?? "#ccc"),
                    }} />
                  </button>
                ))}
              </div>
            </>
          )}
          <div style={groupLabel}>Base</div>
          <div style={swatchRow}>
            {base.map(([k, v]) => (
              <button key={k} type="button" title={k} style={swatchBtn(currentRef === `colors.${k}`)}
                onClick={() => pick(`colors.${k}`)}>
                <span style={{ ...swatch, background: v }} />
              </button>
            ))}
          </div>
          {(["primary", "palette"] as const).map((name) => ramp(name).length > 0 && (
            <div key={name}>
              <div style={groupLabel}>{name === "primary" ? "Primary" : "Palette"}</div>
              <div style={swatchRow}>
                {ramp(name).map(([step, v]) => (
                  <button key={step} type="button" title={`${name}.${step}`}
                    style={swatchBtn(currentRef === `colors.${name}.${step}`)}
                    onClick={() => pick(`colors.${name}.${step}`)}>
                    <span style={{ ...swatch, background: v }} />
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div style={groupLabel}>Custom — {colorScheme} only</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input type="color" aria-label={`${token.label} colour picker`} style={{ ...swatchInput }}
              value={/^#[0-9a-f]{6}$/i.test(resolved) ? resolved : "#000000"}
              onChange={(e) => pick(e.target.value)} />
            <input type="text" style={control} defaultValue={currentRef.startsWith("colors.") ? "" : currentRef}
              placeholder="#rrggbb, rgba(), transparent"
              onBlur={(e) => e.target.value && pick(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Dispatch on the token's declared type; anything unrecognised stays text. */
export function TokenControl({ token, ctx, value, onChange, onReset }: TokenControlProps) {
  const resolved = String(
    resolveTokenValue(value ?? ctx.tokens[token.key], ctx.colors, ctx.tokens, ctx.density, ctx.colorScheme) ?? "",
  );
  const overridden = value !== undefined;

  return (
    <Row token={token} overridden={overridden} onReset={onReset}>
      {token.type === "select" && (
        <SelectControl token={token} value={value} resolved={resolved} onChange={onChange} />
      )}
      {token.type === "size" && (
        <SizeControl value={value} resolved={resolved} density={ctx.density} onChange={onChange} />
      )}
      {token.type === "numeric" && (
        <UnitControl token={token} resolved={resolved} onChange={onChange} />
      )}
      {token.type === "color" && (
        <ColorControl token={token} value={value} ctx={ctx} resolved={resolved} onChange={onChange} />
      )}
      {!["select", "size", "numeric", "color"].includes(token.type) && (
        <input type="text" style={control} value={typeof value === "string" ? value : ""}
          placeholder={resolved || "theme default"} onChange={(e) => onChange(e.target.value)} />
      )}
    </Row>
  );
}

// ---- Styles ------------------------------------------------------------------

const rowWrap: React.CSSProperties = { marginBottom: 10 };
const rowHead: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3,
};
const rowLabel: React.CSSProperties = { fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const hint: React.CSSProperties = { fontSize: 11, color: ui.color.textMuted, marginTop: 3 };
const control: React.CSSProperties = {
  flex: 1, minWidth: 0, width: "100%", fontFamily: ui.font.ui, fontSize: 12.5, padding: "4px 6px",
  border: `1px solid ${ui.color.border}`, borderRadius: 6, color: ui.color.text, background: "#fff",
};
const trigger: React.CSSProperties = {
  ...control, display: "flex", alignItems: "center", justifyContent: "space-between",
  gap: 6, cursor: "pointer", textAlign: "left",
};
const resetBtn: React.CSSProperties = {
  border: "none", background: "none", color: ui.color.accent, fontSize: 11,
  cursor: "pointer", padding: "0 2px", flex: "0 0 auto",
};
const popover: React.CSSProperties = {
  marginTop: 6, padding: 8, border: `1px solid ${ui.color.border}`, borderRadius: 8,
  background: "#fbfbfd",
};
const segmented: React.CSSProperties = { display: "flex", gap: 4, marginBottom: 8 };
const segment = (on: boolean): React.CSSProperties => ({
  flex: 1, fontSize: 11.5, padding: "3px 0", cursor: "pointer", borderRadius: 5,
  border: `1px solid ${on ? ui.color.accent : ui.color.border}`,
  background: on ? ui.color.accent : "#fff", color: on ? "#fff" : ui.color.text,
});
const scrollList: React.CSSProperties = { maxHeight: 190, overflowY: "auto" };
const listItem = (on: boolean): React.CSSProperties => ({
  display: "flex", justifyContent: "space-between", width: "100%", fontSize: 12,
  padding: "4px 6px", cursor: "pointer", borderRadius: 5, textAlign: "left",
  border: `1px solid ${on ? ui.color.accent : "transparent"}`,
  background: on ? "#eef2ff" : "transparent", color: ui.color.text,
});
const groupLabel: React.CSSProperties = {
  fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4,
  color: ui.color.textMuted, margin: "8px 0 4px",
};
const swatchRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4 };
const swatch: React.CSSProperties = {
  width: 16, height: 16, borderRadius: 4, flex: "0 0 16px",
  border: "1px solid rgba(0,0,0,0.15)", display: "inline-block",
};
const swatchBtn = (on: boolean): React.CSSProperties => ({
  padding: 2, borderRadius: 5, cursor: "pointer", lineHeight: 0,
  border: `2px solid ${on ? ui.color.accent : "transparent"}`, background: "none",
});
const swatchInput: React.CSSProperties = {
  width: 30, flex: "0 0 30px", padding: 0, height: 26,
  border: `1px solid ${ui.color.border}`, borderRadius: 6, background: "#fff", cursor: "pointer",
};
const unitTag: React.CSSProperties = { fontSize: 11, color: ui.color.textMuted };
