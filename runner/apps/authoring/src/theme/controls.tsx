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
// pickers are hand-rolled popovers anchored under their triggers — floating,
// as Theme Builder's are, since the panel matched its row layout (label + ⓘ
// left, control right). The known cost: a popover opened at the very bottom
// of the panel extends the body's scroll rather than flipping upward.

import { useState } from "react";
import {
  headerLabel,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconInfoCircle,
  theme as ui,
} from "@handsontable/demo-editor-shell";
import type { ColorsMap, TokenMap } from "./presets.js";
import { COMMON_COLORS_KEYS } from "./presets.js";
import { mergeForColorScheme, resolveTokenValue, tokenValueLabel } from "./resolve.js";
import type { ColorScheme, Token, TokenValue } from "./vocabulary.js";

export interface ControlContext {
  /** Preset tokens with the panel's overrides layered on. */
  tokens: TokenMap;
  colors: ColorsMap;
  density: Record<string, string>;
  /** The sizing scale — `{ size_1: "4px", … }`. Passed in rather than imported
   *  from `presets.ts`, so it can come from the Handsontable version the demo is
   *  pinned to instead of the one this app is built with (DEV-2560). */
  sizing: Record<string, string>;
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

/** An inline disclosure's state marker. `textMuted` rather than the old glyph's
 *  `opacity: 0.6` — an opacity on the arrow also dimmed nothing else, and the
 *  muted token is what every other secondary mark in the shell uses. */
function Chevron({ open }: { open: boolean }) {
  const Glyph = open ? IconChevronUp : IconChevronDown;
  return <Glyph size={14} style={{ color: ui.color.textMuted, flex: "0 0 auto" }} />;
}

/** Theme Builder's row: label with the description behind an ⓘ on the left,
 *  the control on the right, and a Reset that appears only when the token is
 *  actually overridden. The description used to be a line under every control —
 *  272 rows of always-on hint text; the tooltip shows it on intent instead. */
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
    // `data-token` is the stable hook a test can pick a row by: this is a `div`,
    // so `label`-based locators cannot reach it, and the label text ("Vertical")
    // repeats across groups.
    <div style={rowWrap} data-token={token.key}>
      <span style={rowLabelCell}>
        <span style={rowLabel} title={token.key}>{token.label}</span>
        {token.description && (
          // Focusable, so the tooltip is keyboard-reachable; the CSS lives in
          // panels.css (`.hot-info`), a ::after no inline style can express.
          <span className="hot-info" data-tip={token.description} tabIndex={0} role="img" aria-label={token.description}>
            <IconInfoCircle size={14} />
          </span>
        )}
        {overridden && (
          <button type="button" style={resetBtn} onClick={onReset} title={`Reset ${token.key}`}>
            Reset
          </button>
        )}
      </span>
      <div style={rowControl}>{children}</div>
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
    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

type SizeMode = "sizing" | "density" | "custom";

/** Which list to open on: the mode the *effective* value already speaks, so an
 *  untouched token whose preset value is `sizing.size_1` opens on the sizing
 *  scale rather than a blank text box (DEV-2560). */
function modeFor(effectiveRef: string, modes: readonly SizeMode[]): SizeMode {
  const guessed: SizeMode = effectiveRef.startsWith("sizing.")
    ? "sizing"
    : effectiveRef.startsWith("density.") ? "density" : "custom";
  return modes.includes(guessed) ? guessed : modes[0]!;
}

/**
 * `size` — pick from the sizing scale, follow a density slot, or type a value.
 *
 * The density option is the interesting one: a token set to `density.cellHorizontal`
 * keeps tracking the density preset, so switching compact/comfortable still moves it.
 * It is also the one the density-size rows must not offer — a density measurement
 * pointing at a density slot is a measurement pointing at itself — hence `modes`.
 */
function SizeControl({ value, resolved, effectiveRef = "", density, sizing, modes = ["sizing", "density", "custom"], onChange }: {
  value: TokenValue | undefined;
  resolved: string;
  /** The raw value in force — the override, or the preset's own reference. */
  effectiveRef?: string;
  density: Record<string, string>;
  sizing: Record<string, string>;
  modes?: readonly SizeMode[];
  onChange: (v: string) => void;
}) {
  const raw = typeof value === "string" ? value : "";
  /** The reference in force — the override, else the preset's own. Both the mode
   *  the popover opens on and the row it highlights follow this: keying either to
   *  `raw` alone left an untouched token on a list with nothing selected, while
   *  its trigger already showed the resolved preset value. */
  const current = raw || effectiveRef;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SizeMode>(() => modeFor(current, modes));

  return (
    <div style={anchor}>
      <button type="button" style={trigger} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={ellipsis}>{resolved || "theme default"}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div style={popover}>
          <div style={segmented}>
            {modes.map((m) => (
              <button key={m} type="button" style={segment(mode === m)} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
          {mode === "sizing" && (
            <div style={scrollList}>
              {/* By value, not by name: the scale declares `size_1_5` after
                  `size_2` and `size_0_25` last, and `parseFloat` is what keeps
                  the sub-pixel steps in order. */}
              {Object.entries(sizing)
                .sort((a, b) => parseFloat(a[1]) - parseFloat(b[1]))
                .map(([k, v]) => (
                  <button key={k} type="button" className="hot-panel-list-item" style={listItem}
                    data-active={current === `sizing.${k}`}
                    onClick={() => onChange(`sizing.${k}`)}>
                    <span>{k}</span><span style={listItemValue}>{v}</span>
                  </button>
                ))}
            </div>
          )}
          {mode === "density" && (
            <div style={scrollList}>
              {Object.keys(density).map((k) => (
                <button key={k} type="button" className="hot-panel-list-item" style={listItem}
                  data-active={current === `density.${k}`}
                  onClick={() => onChange(`density.${k}`)}>
                  <span>{k.replace(/([A-Z])/g, " $1").replace(/^\w/, (c) => c.toUpperCase())}</span>
                  <span style={listItemValue}>{density[k]}</span>
                </button>
              ))}
            </div>
          )}
          {mode === "custom" && (
            // Seeded with anything that isn't a scale reference, not just `px`:
            // `1rem`, `50%` and unitless numbers are all valid sizes, and
            // reopening the editor blank while the trigger showed the real value
            // made the next edit a guess.
            //
            // From `raw`, not `current`: seeding an untouched token with the
            // preset's literal would let a blur alone commit that literal as an
            // override. The resolved value is the placeholder instead.
            <input type="text" style={{ ...control, width: "100%" }}
              defaultValue={/^(sizing|density)\./.test(raw) ? "" : raw}
              placeholder={resolved || "e.g. 12px, 1rem, 50%"}
              onBlur={(e) => e.target.value && onChange(e.target.value)} />
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
/** A collapsible swatch group inside the colour dropdown — Theme Builder's
 *  Base / Palette / Primary sections, chevron and all. */
function ColorGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const Glyph = open ? IconChevronDown : IconChevronRight;
  return (
    <div>
      <button type="button" style={groupToggle} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Glyph size={14} style={{ color: ui.color.textMuted, flex: "0 0 auto" }} />
        <span>{label}</span>
      </button>
      {open && children}
    </div>
  );
}

function ColorControl({ token, value, ctx, resolved, onChange }: {
  token: Token;
  value: TokenValue | undefined;
  ctx: ControlContext;
  resolved: string;
  onChange: (v: TokenValue) => void;
}) {
  const [open, setOpen] = useState(false);
  // Theme Builder's two-tab dropdown: "Common" is every named colour the theme
  // already carries, "Pick color" the raw picker (the old "Custom" row).
  const [pickerTab, setPickerTab] = useState<"common" | "custom">("common");
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
    <div style={anchor}>
      <button type="button" style={trigger} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ ...swatch, background: resolved || "transparent" }} />
          <span style={ellipsis}>{tokenValueLabel(effective, colorScheme) || "theme default"}</span>
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div style={popover}>
          <div style={segmented}>
            <button type="button" style={segment(pickerTab === "common")} onClick={() => setPickerTab("common")}>
              Common
            </button>
            <button type="button" style={segment(pickerTab === "custom")} onClick={() => setPickerTab("custom")}>
              Pick color
            </button>
          </div>
          {pickerTab === "common" ? (
            <>
              {!COMMON_COLORS_KEYS.includes(token.key as (typeof COMMON_COLORS_KEYS)[number]) && (
                <ColorGroup label="Common">
                  <div style={swatchRow}>
                    {COMMON_COLORS_KEYS.map((key) => (
                      <button key={key} type="button" title={key}
                        className="hot-swatch-btn" style={swatchBtn}
                        data-active={currentRef === `tokens.${key}`}
                        onClick={() => onChange(`tokens.${key}`)}>
                        <span style={{
                          ...swatchLg,
                          background: String(resolveTokenValue(tokens[key], { ...ctx, tokens, colors }) ?? "#ccc"),
                        }} />
                      </button>
                    ))}
                  </div>
                </ColorGroup>
              )}
              <ColorGroup label="Base">
                <div style={swatchRow}>
                  {base.map(([k, v]) => (
                    <button key={k} type="button" title={k} className="hot-swatch-btn" style={swatchBtn}
                      data-active={currentRef === `colors.${k}`}
                      onClick={() => pick(`colors.${k}`)}>
                      <span style={{ ...swatchLg, background: v }} />
                    </button>
                  ))}
                </div>
              </ColorGroup>
              {(["palette", "primary"] as const).map((name) => ramp(name).length > 0 && (
                <ColorGroup key={name} label={name === "primary" ? "Primary" : "Palette"}>
                  <div style={swatchRow}>
                    {ramp(name).map(([step, v]) => (
                      <button key={step} type="button" title={`${name}.${step}`}
                        className="hot-swatch-btn" style={swatchBtn}
                        data-active={currentRef === `colors.${name}.${step}`}
                        onClick={() => pick(`colors.${name}.${step}`)}>
                        <span style={{ ...swatchLg, background: v }} />
                      </button>
                    ))}
                  </div>
                </ColorGroup>
              ))}
            </>
          ) : (
            <>
              <div style={groupLabel}>Applies to {colorScheme} mode only</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="color" className="hot-color-input" aria-label={`${token.label} colour picker`}
                  value={/^#[0-9a-f]{6}$/i.test(resolved) ? resolved : "#000000"}
                  onChange={(e) => pick(e.target.value)} />
                <input type="text" style={control} defaultValue={currentRef.startsWith("colors.") ? "" : currentRef}
                  placeholder="#rrggbb, rgba(), transparent"
                  onBlur={(e) => e.target.value && pick(e.target.value)} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Dispatch on the token's declared type; anything unrecognised stays text. */
export function TokenControl({ token, ctx, value, onChange, onReset }: TokenControlProps) {
  const resolved = String(resolveTokenValue(value ?? ctx.tokens[token.key], ctx) ?? "");
  const overridden = value !== undefined;

  return (
    <Row token={token} overridden={overridden} onReset={onReset}>
      {token.type === "select" && (
        <SelectControl token={token} value={value} resolved={resolved} onChange={onChange} />
      )}
      {token.type === "size" && (
        <SizeControl
          value={value}
          resolved={resolved}
          effectiveRef={typeof (value ?? ctx.tokens[token.key]) === "string" ? String(value ?? ctx.tokens[token.key]) : ""}
          density={ctx.density}
          sizing={ctx.sizing}
          onChange={onChange}
        />
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

/**
 * One density measurement, on the same size control the 65 `size` tokens use
 * (DEV-2560).
 *
 * These were free-text boxes: to raise cell padding you had to know that `8px`
 * was a legal value and that the preset said `sizing.size_2`, neither of which
 * the row told you. Theme Builder offers a picker, and so does this now.
 *
 * No `density` mode — a density measurement that points at a density slot points
 * at itself. `Row` supplies the label, the description and the Reset, exactly as
 * for a token, so an overridden measurement can be put back without knowing that
 * clearing the box is what does it.
 */
export function DensitySizeControl({ token, ctx, value, resolved, effectiveRef, onChange, onReset }: {
  token: Token;
  ctx: ControlContext;
  value: string | undefined;
  /** The measurement in force, resolved through the scale — `"4px"`. */
  resolved: string;
  /** The raw value in force — `"sizing.size_1"`, or a literal. */
  effectiveRef: string;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  return (
    <Row token={token} overridden={value !== undefined} onReset={onReset}>
      <SizeControl
        value={value}
        resolved={resolved}
        effectiveRef={effectiveRef}
        density={{}}
        sizing={ctx.sizing}
        modes={["sizing", "custom"]}
        onChange={onChange}
      />
    </Row>
  );
}

// ---- Styles ------------------------------------------------------------------
//
// Every colour here is a shell token (DEV-2209). This file used to carry six
// literals — `#fff` on the control, the trigger, the segmented control and the
// colour input, `#fbfbfd` on the popover, `#eef2ff` on a selected row — which
// were correct on master, where the panel had no dark mode. Measured on the
// shipped dark shell, the trigger rendered `#ffffff` behind `#d1d1d4` text:
// ~1.4:1, unreadable, on the control every one of the 272 tokens is edited with.
//
// `controlBorder`, not `border`, on anything meant to read as an outline: the
// panel is `surfaceRaised`, and dark `border` *is* `surfaceRaised` (theme.ts).

/** Theme Builder's two columns: label + ⓘ left, a fixed control column right. */
const rowWrap: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "minmax(0, 1fr) 176px", alignItems: "center",
  gap: ui.space(2), marginBottom: ui.space(2),
};
const rowLabelCell: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: ui.space(1), minWidth: 0,
};
/** The popovers' positioning context — each control column anchors its own. */
const rowControl: React.CSSProperties = { position: "relative", minWidth: 0 };
const anchor: React.CSSProperties = { position: "relative" };
const rowLabel: React.CSSProperties = { ...ui.type.base, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const ellipsis: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const control: React.CSSProperties = {
  flex: 1, minWidth: 0, width: "100%", fontFamily: ui.font.ui, ...ui.type.base,
  padding: `${ui.space(1)} ${ui.space(2)}`,
  border: `1px solid ${ui.color.controlBorder}`, borderRadius: ui.radius.sm,
  color: ui.color.text, background: ui.color.surface,
};
const trigger: React.CSSProperties = {
  ...control, display: "flex", alignItems: "center", justifyContent: "space-between",
  gap: ui.space(2), cursor: "pointer", textAlign: "left",
};
const resetBtn: React.CSSProperties = {
  border: "none", background: "none", color: ui.color.accentText, fontSize: 12,
  cursor: "pointer", padding: `0 ${ui.space(1)}`, flex: "0 0 auto",
};
/** Floating, Theme Builder-style: anchored under the trigger, right-aligned so
 *  it can be wider than the control column without leaving the 400px drawer.
 *  `surfaceRaised` + the popover shadow — the recipe every shell popover uses. */
const popover: React.CSSProperties = {
  position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 30,
  width: 288, maxWidth: "80vw", padding: ui.space(2),
  border: `1px solid ${ui.color.controlBorder}`, borderRadius: ui.radius.md,
  background: ui.color.surfaceRaised, boxShadow: ui.shadow.popover,
};
/** Theme Builder's segmented controller: a muted track, the selected segment a
 *  raised pill — not the accent-filled buttons this used to draw. */
const segmented: React.CSSProperties = {
  display: "flex", gap: ui.space(1), padding: ui.space(1),
  background: ui.color.surfaceMuted, borderRadius: ui.radius.md,
  marginBottom: ui.space(2),
};
const segment = (on: boolean): React.CSSProperties => ({
  flex: 1, ...ui.type.base, padding: `${ui.space(1)} 0`, cursor: "pointer", borderRadius: ui.radius.sm,
  textTransform: "capitalize", fontFamily: ui.font.ui,
  border: `1px solid ${on ? ui.color.controlBorder : "transparent"}`,
  background: on ? ui.color.surfaceRaised : "transparent",
  color: on ? ui.color.text : ui.color.textMuted,
  fontWeight: on ? 600 : 400,
});
/** The collapsible group header inside the colour dropdown. */
const groupToggle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: ui.space(1),
  margin: `${ui.space(1)} 0`, padding: 0, border: "none", background: "none",
  fontFamily: ui.font.ui, ...ui.type.base, color: ui.color.text, cursor: "pointer",
};
const scrollList: React.CSSProperties = { maxHeight: 190, overflowY: "auto" };
/** The resolved value trailing a scale entry. `textMuted`, not the old
 *  `opacity: 0.6` — it has to stay legible on the hover fill. */
const listItemValue: React.CSSProperties = { color: ui.color.textMuted };
/** No `background` and no `border-color`: `.hot-panel-list-item` owns both,
 *  base then hover then `[data-active]`, or an inline fill would outrank the
 *  rollover (ADR-0026). Width and style stay here so nothing reflows. */
const listItem: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", width: "100%", fontSize: 13,
  padding: `${ui.space(1)} ${ui.space(2)}`, cursor: "pointer", borderRadius: ui.radius.sm,
  textAlign: "left", borderWidth: 1, borderStyle: "solid", color: ui.color.text,
};
/** The shell's own small-caps section type (`SectionHeader.headerLabel`), rather
 *  than a fourth hand-rolled copy of it. */
const groupLabel: React.CSSProperties = { ...headerLabel, display: "block", margin: `${ui.space(2)} 0 ${ui.space(1)}` };
const swatchRow: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: ui.space(1) };
const swatch: React.CSSProperties = {
  width: 16, height: 16, borderRadius: ui.radius.sm, flex: "0 0 16px",
  border: `1px solid ${ui.color.controlBorder}`, display: "inline-block",
};
/** The dropdown's pick targets — Theme Builder draws these at ~28px, and a 16px
 *  square is a hard thing to hit with a mouse. */
const swatchLg: React.CSSProperties = { ...swatch, width: 24, height: 24, flex: "0 0 24px" };
/** Same split as `listItem` — `.hot-swatch-btn` carries the border colour. */
const swatchBtn: React.CSSProperties = {
  padding: 2, borderRadius: ui.radius.sm, cursor: "pointer", lineHeight: 0,
  borderWidth: 2, borderStyle: "solid", background: "none",
};
const unitTag: React.CSSProperties = { fontSize: 12, color: ui.color.textMuted };
