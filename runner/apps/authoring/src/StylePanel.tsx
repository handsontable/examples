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

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Drawer,
  headerLabel,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconPalette,
  theme as ui,
} from "@handsontable/demo-editor-shell";
import { reportError } from "./sentry.js";
import type { FilesMap, WriteFileOptions } from "@handsontable/demo-runtime";
import {
  buildResetChanges,
  buildThemeChanges,
  buildThemeParams,
  buildThemeSnippet,
  isTypescript,
  manualImportHint,
  THEME_BRIDGE_SOURCE,
  themeModulePath,
} from "./theme/codegen.js";
import {
  ALL_TOKENS,
  COLORS_PRESETS,
  COLOR_SCHEMES,
  DEFAULT_THEME,
  DENSITY_GROUPS,
  DENSITY_VARIANTS,
  googleFontFamily,
  ICONS_PRESETS,
  isPristine,
  densitySizeCount,
  migrateThemeState,
  COMMON_SECTIONS,
  COMPONENT_SECTIONS,
  NEUTRAL_STEPS,
  PRIMARY_STEPS,
  TOKENS_PRESETS,
  type ThemeState,
  type Token,
  type TokenValue,
} from "./theme/vocabulary.js";
import {
  INTERACTION_ONLY_NOTE,
  mergeSuggestion,
  NOTHING_CHANGED_NOTE,
  type ThemeAnswer,
} from "./theme/suggestion.js";
import { type ColorsMap } from "./theme/presets.js";
import { bundledPresets, loadPresets, type PresetSet } from "./theme/presetsFor.js";
import { hexInputValue, isTransparentHex } from "./theme/color.js";
import {
  effectiveColors,
  effectiveDensity,
  effectiveTokens,
  getNestedValue,
  resolveTokenValue,
} from "./theme/resolve.js";
import { DensitySizeControl, TokenControl, type ControlContext } from "./theme/controls.js";

/** Foundation / Common / Component / AI ✨, as theme-builder splits its panel. */
type Tab = "foundation" | "common" | "component" | "ai";

const STORAGE_KEY = "hot-runner-theme";

/**
 * How long a live patch may take to be acknowledged before the panel gives up on
 * the bridge and lets the change land by rebuild instead (DEV-2496).
 *
 * It is a round trip between two frames on the same machine — single-digit
 * milliseconds — so this is not a latency budget, it is how long to wait before
 * concluding there is nobody there: a demo that has not compiled since the theme
 * was wired in, an example whose grid the panel could not find, a preview that has
 * just been torn down.
 */
const BRIDGE_ACK_TIMEOUT_MS = 300;

/** Trailing delay on the writes the bridge did not cover. Long enough to coalesce a
 *  drag into one rebuild, short enough to read as immediate on a single click. */
const FLUSH_DELAY_MS = 250;

function writeStorage(state: ThemeState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* private browsing; the theme just will not survive a reload */ }
}

/**
 * Changes the running theme object cannot absorb, so the demo has to be rebuilt.
 *
 * The three presets are `import`s in the generated module — a different tokens,
 * colors or icons module is a different file, not a different value. A Google font
 * is the same story from the other end: the module appends the stylesheet `<link>`
 * that makes the family available, and `params()` setting `fontFamily` to a font the
 * document never loaded renders in the fallback.
 */
function needsRebuild(prev: ThemeState, next: ThemeState): boolean {
  return prev.tokens !== next.tokens
    || prev.colors !== next.colors
    || prev.icons !== next.icons
    || googleFontFamily(prev.params.fontFamily) !== googleFontFamily(next.params.fontFamily);
}

export interface StylePanelProps {
  apiBase: string;
  /** Broker token of the signed-in user. /api/theme runs the same budget gate
   *  as the chat route, so without this a signed-in user is refused at the
   *  `anon_blocked` tier — exactly when the tier means to keep them working. */
  token: string | null;
  /** The Handsontable version the demo is pinned to. The panel resolves preset
   *  defaults against *this* version rather than the one the app is built with
   *  (DEV-2560) — see `theme/presetsFor.ts`. */
  htVersion: string;
  getFiles: () => FilesMap;
  /** Write a file into the editor + running preview. `{ quiet: true }` keeps the
   *  file and skips the rebuild, for a change the bridge has already applied. */
  applyEdit: (path: string, contents: string, opts?: WriteFileOptions) => void;
  /** Send a message into the preview frame (the live theme patch). */
  postToPreview: (message: unknown) => void;
  /** Subscribe to messages coming back out of it; returns an unsubscribe. */
  onPreviewMessage: (cb: (data: unknown) => void) => () => void;
  /** Rebuild with whatever the quiet writes are holding — the fallback when a live
   *  patch does not land. */
  flushQuietEdits: () => void;
  onClose: () => void;
}

export function StylePanel({
  apiBase,
  token,
  htVersion,
  getFiles,
  applyEdit,
  postToPreview,
  onPreviewMessage,
  flushQuietEdits,
  onClose,
}: StylePanelProps) {
  // Restored across reloads, as theme-builder does — a theme is worth several
  // minutes of fiddling and losing it to a refresh is its own small tragedy.
  const [state, setState] = useState<ThemeState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? migrateThemeState(JSON.parse(saved)) : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  });
  const [prompt, setPrompt] = useState("");
  const [thinking, setThinking] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("foundation");
  /** The component whose sub-panel is open, e.g. "Buttons". */
  const [component, setComponent] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string>("");
  /** Which density variant the sizes editor is pointed at. Starts on the
   *  restored theme's own variant, not the default — otherwise reloading a
   *  compact theme opens the editor on `default`, warning that the sizes won't
   *  show, while the sizes it should be showing sit one click away. */
  const [densityVariant, setDensityVariant] = useState<ThemeState["density"]>(() => state.density);
  const [showCode, setShowCode] = useState(false);
  const [applied, setApplied] = useState<{ linked: boolean } | null>(null);
  /** The preset data the controls resolve against — the demo's own Handsontable
   *  version, fetched, with this app's copy as the synchronous first render and
   *  the fallback (DEV-2560). */
  const [presets, setPresets] = useState<PresetSet>(() => bundledPresets(state.tokens, state.colors));
  const [loadingPresets, setLoadingPresets] = useState(false);

  /**
   * Is there a live theme bridge in the preview right now? (DEV-2496)
   *
   * Set by the `ready` the generated module posts as it evaluates, and cleared by
   * every write that rebuilds. Cleared, not kept: each evaluation of that module
   * calls `reinitTheme`, which *replaces* the registered ThemeBuilder rather than
   * notifying the old one's subscribers — so a bridge is only good until the next
   * rebuild, and patching across one would go to an object no grid is listening to.
   */
  const bridgeReady = useRef(false);
  /** The current theme, readable from the unmount cleanup — which runs after the last
   *  render and so cannot see `state` through a stale closure. */
  const stateRef = useRef(state);
  /** The loaded presets, for the same reason: `patchLive` is called from `apply`,
   *  which runs inside the setState burst that changed the theme. */
  const presetsRef = useRef(presets);
  /** Live patches in flight, by id, waiting for their `ack`. */
  const acks = useRef(new Map<number, (ok: boolean) => void>());
  const patchSeq = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => onPreviewMessage((data) => {
    const message = data as { source?: string; ready?: boolean; ack?: number; ok?: boolean } | null;
    if (!message || message.source !== THEME_BRIDGE_SOURCE) return;
    if (message.ready) {
      bridgeReady.current = true;
      return;
    }
    if (typeof message.ack === "number") acks.current.get(message.ack)?.(message.ok === true);
  }), [onPreviewMessage]);

  // Nothing here may outlive the panel: a pending rebuild would never be asked for
  // again (the workspace has the theme, the preview would not), and a pending
  // localStorage write is the theme this session spent its time on.
  useEffect(() => () => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushQuietEdits();
    }
    if (storageTimer.current) {
      clearTimeout(storageTimer.current);
      writeStorage(stateRef.current);
    }
    // Mount/unmount only; the callbacks are stable for the panel's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The preset data for the demo's own Handsontable version (DEV-2560). Loaded
  // for display only — `state` holds overrides and nothing else, so a version
  // change re-resolves what the controls *show* and touches no value the user
  // set. The previous set stays on screen while the next one lands: blanking the
  // panel mid-load would be a worse lie than a stale number, and an override
  // typed during the load is version-independent and must still commit.
  useEffect(() => {
    let live = true;
    setLoadingPresets(true);
    loadPresets(htVersion, state.tokens, state.colors)
      .then((loaded) => { if (live) { presetsRef.current = loaded; setPresets(loaded); } })
      .finally(() => { if (live) setLoadingPresets(false); });
    return () => { live = false; };
  }, [htVersion, state.tokens, state.colors]);

  // A theme restored from a previous session describes files this demo may not
  // have — reopening the panel, or opening a different example, must reconcile
  // the two rather than wait for the next edit to notice.
  useEffect(() => {
    if (!isPristine(state)) apply(state);
    // Mount only: later changes go through update(), which applies as it goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The snippet has to be in the demo's own language (DEV-2216), which is a
  // property of the files it sits next to — and those can be replaced while
  // this panel stays mounted, because picking another starter swaps the whole
  // workspace in place. So the language is read on every render and is a
  // dependency of the snippet; `getFiles` itself cannot be one, since it is an
  // inline arrow at the call site and would defeat the memo outright.
  const typescript = isTypescript(getFiles());
  const snippet = useMemo(() => buildThemeSnippet(state, typescript), [state, typescript]);
  const pristine = isPristine(state);

  /** What the controls resolve against: the chosen presets with this panel's
   *  overrides layered on. Recomputed per edit so a resolved value never lags
   *  behind the grid it is describing. */
  const ctx: ControlContext = useMemo(() => ({
    tokens: effectiveTokens(presets.tokens, state.params),
    colors: effectiveColors(presets.colors, state.palette),
    density: effectiveDensity(presets.density[state.density] ?? {}, state.densitySizes[state.density] ?? {}),
    sizing: presets.sizing,
    colorScheme: state.colorScheme,
  }), [presets, state]);

  /** The density measurements for the variant the *sizes editor* is pointed at,
   *  overrides layered on. Not `ctx.density`, which follows the variant the grid
   *  is on — the two differ whenever the switcher has been moved, and a row has
   *  to show the value it is editing. */
  const editedDensity = useMemo(
    () => effectiveDensity(presets.density[densityVariant] ?? {}, state.densitySizes[densityVariant] ?? {}),
    [presets, densityVariant, state.densitySizes],
  );

  /** What a density measurement actually comes out as: the preset stores
   *  references (`"sizing.size_1"`), and the row has to read `4px`. */
  const resolvedDensitySize = (key: string) =>
    String(resolveTokenValue(editedDensity[key], { ...ctx, density: editedDensity }) ?? "");

  /** The colour the brand ramp is generated from — the effective `primary.500`,
   *  so the picker opens on the preset's blue rather than a hard-coded one that
   *  is wrong for every preset but `main`. */
  const brandColour = hexInputValue(
    state.palette["primary.500"] ?? String(getNestedValue(ctx.colors, "primary.500") ?? ""),
    "#1a42e8",
  );

  /** One token row, wired to the panel's state. */
  const tokenRow = (token: Token) => (
    <TokenControl
      key={token.key}
      token={token}
      ctx={ctx}
      value={state.params[token.key]}
      onChange={(v) => setParam(token.key, v, token.linkedTokens)}
      onReset={() => resetParam(token.key, token.linkedTokens)}
    />
  );

  const overrideCount = (tokens: Token[]) => tokens.filter((t) => state.params[t.key] !== undefined).length;

  /** Rebuild the preview from the files, once, after the current burst of changes.
   *  Trailing rather than immediate: a colour drag is thirty changes, and it deserves
   *  one rebuild rather than thirty. */
  function scheduleFlush() {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      flushQuietEdits();
    }, FLUSH_DELAY_MS);
  }

  /** Hand the theme to the running grid, and report whether it got there — with the
   *  id it was sent under, so a late answer can be recognised as stale. */
  function patchLive(next: ThemeState): Promise<{ id: number; ok: boolean }> {
    const id = ++patchSeq.current;
    return new Promise<{ id: number; ok: boolean }>((resolve) => {
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        acks.current.delete(id);
        resolve({ id, ok });
      };
      const timer = setTimeout(() => settle(false), BRIDGE_ACK_TIMEOUT_MS);
      acks.current.set(id, settle);
      // The demo's own version's presets when they are loaded — the payload is
      // effective objects, so the presets travel inside it (DEV-2560).
      postToPreview({ source: THEME_BRIDGE_SOURCE, id, params: buildThemeParams(next, presetsRef.current) });
    });
  }

  /**
   * Write the theme into the demo. Every change goes through the editor's own
   * applyEdit, so the file shows up in the file tree and in a download.
   *
   * The write is always quiet, and what rebuilds the preview is decided afterwards
   * (DEV-2496). With a bridge in the preview and nothing structural in the change,
   * the running grid is patched instead and no rebuild happens at all — which is the
   * whole point: a rebuild re-evaluates the demo, and dragging a colour picker
   * through thirty of them is the "blink blink" this panel was reported for.
   * Otherwise a single trailing rebuild lands the change the ordinary way.
   *
   * `prev === undefined` means the mount reconcile, which cannot be live: the theme
   * has not been wired into this demo yet.
   */
  function apply(next: ThemeState, prev?: ThemeState) {
    const { changes, linked } = buildThemeChanges(getFiles(), next);
    for (const change of changes) applyEdit(change.path, change.contents, { quiet: true });
    setApplied({ linked });

    const live = linked && bridgeReady.current && prev !== undefined && !needsRebuild(prev, next);
    if (!live) {
      // The rebuild re-evaluates the module, so the bridge that comes back is a new
      // one; it announces itself and sets this again.
      bridgeReady.current = false;
      scheduleFlush();
      return;
    }

    void patchLive(next).then(({ id, ok }) => {
      // Only the newest patch may decide. An earlier one settling late describes a
      // theme two drag frames old, and would order a rebuild nobody needs.
      if (ok || id !== patchSeq.current) return;
      // Screen and files must not be allowed to disagree: if the patch was refused
      // (a half-typed colour, a grid that never subscribed) the file is what has to
      // land, so ask for the rebuild after all.
      bridgeReady.current = false;
      scheduleFlush();
    });
  }

  /** localStorage on a trailing timer, for the same reason as the rebuild: a drag
   *  would otherwise serialise the whole theme on every frame. */
  function persist(next: ThemeState) {
    if (storageTimer.current) clearTimeout(storageTimer.current);
    storageTimer.current = setTimeout(() => {
      storageTimer.current = null;
      writeStorage(next);
    }, FLUSH_DELAY_MS);
  }

  function update(patch: Partial<ThemeState>) {
    const next = { ...state, ...patch };
    setState(next);
    stateRef.current = next;
    apply(next, state);
    persist(next);
  }

  /**
   * "Describe a style" — theme-builder's headline feature. The server returns
   * whitelisted theme values, which are merged on top of what is already set so a
   * follow-up ("now make the header darker") refines rather than resets.
   *
   * What comes back is *checked* rather than announced (DEV-2497). The model's
   * message is a claim about what it did, and it was reported as a bug when the
   * claim was true and the grid still looked identical: a brand ramp paints
   * selection, focus and the active header, none of which is on screen until you
   * touch the grid. `mergeSuggestion` says whether the theme moved and whether
   * anything at rest moved with it, so the panel can say the same.
   */
  async function describe(text: string) {
    const request = text.trim();
    if (!request || thinking) return;
    setThinking(true);
    setAiNote(null);
    try {
      const res = await fetch(`${apiBase}/api/theme`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ prompt: request, current: state }),
      });
      const body = (await res.json().catch(() => ({}))) as ThemeAnswer & { error?: string };
      if (!res.ok) {
        setAiNote(body.message ?? `Unavailable (${res.status}).`);
        return;
      }

      const { next, effect } = mergeSuggestion(state, body);
      if (effect === "none") {
        // Nothing to apply, so nothing is applied: `update()` here would write the
        // theme module and order a rebuild to land a theme identical to the one
        // already running. The prompt is left in the box, because the next thing
        // the user does is edit it.
        setAiNote(NOTHING_CHANGED_NOTE);
        return;
      }

      update(next);
      const message = body.message ?? "Done.";
      setAiNote(effect === "interactionOnly" ? `${message} ${INTERACTION_ONLY_NOTE}` : message);
      setPrompt("");
    } catch (err) {
      reportError(err, "theme-ai");
      setAiNote("Couldn’t reach the styling assistant.");
    } finally {
      setThinking(false);
    }
  }

  /**
   * Set a token, and every token it is linked to.
   *
   * `linkedTokens` in the catalogue pairs a column-header token with its
   * row-header counterpart (`headerForegroundColor` ->
   * `headerRowForegroundColor`, and the highlighted and active variants). They
   * are meant to move together — theme-builder's `TokenItem` writes all of them
   * — because a grid with a restyled column header and a stock row header just
   * looks broken.
   */
  function setParam(name: string, value: TokenValue, linked: string[] = []) {
    const params = { ...state.params };
    const empty = Array.isArray(value)
      ? value.every((v) => !String(v).trim())
      : !String(value).trim();
    for (const key of [name, ...linked]) {
      if (empty) delete params[key];
      else params[key] = value;
    }
    update({ params });
  }

  /** Reset clears the linked tokens too, or they keep a value the control that
   *  set them no longer shows. */
  function resetParam(name: string, linked: string[] = []) {
    const params = { ...state.params };
    for (const key of [name, ...linked]) delete params[key];
    update({ params });
  }

  function setPalette(key: string, value: string) {
    const palette = { ...state.palette };
    if (value.trim()) palette[key] = value;
    else delete palette[key];
    update({ palette });
  }

  /** Density sizes are per variant, so an edit names the variant it belongs to
   *  — you can tune `comfortable` while looking at `compact`. */
  function setDensitySize(variant: ThemeState["density"], name: string, value: string) {
    const forVariant = { ...(state.densitySizes[variant] ?? {}) };
    if (value.trim()) forVariant[name] = value;
    else delete forVariant[name];

    const densitySizes = { ...state.densitySizes };
    if (Object.keys(forVariant).length > 0) densitySizes[variant] = forVariant;
    else delete densitySizes[variant];
    update({ densitySizes });
  }

  /** Spread one colour across the brand ramp, lightest to darkest.
   *  Theme-builder's assistant is told to always set all six steps for a
   *  recolour, because a single step against five stale ones reads as a bug
   *  rather than a new brand colour. */
  function rampFrom(hex: string) {
    const base = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!base) return;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(base[1]!.slice(i, i + 2), 16));
    const mix = (amount: number) => {
      // Positive mixes toward white, negative toward black.
      const blend = (c: number) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
      return `#${[r!, g!, b!].map((c) => blend(c).toString(16).padStart(2, "0")).join("")}`;
    };
    update({
      palette: {
        ...state.palette,
        "primary.100": mix(0.8),
        "primary.200": mix(0.6),
        "primary.300": mix(0.35),
        "primary.400": mix(0.15),
        "primary.500": hex,
        "primary.600": mix(-0.2),
      },
    });
  }

  function reset() {
    // Not quiet, and not scheduled: Reset takes the wiring back out of the demo, which
    // only a rebuild can carry — and it takes the bridge with it, so the theme object
    // the next patch would reach for is about to stop existing.
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (storageTimer.current) {
      clearTimeout(storageTimer.current);
      storageTimer.current = null;
    }
    bridgeReady.current = false;
    for (const change of buildResetChanges(getFiles())) applyEdit(change.path, change.contents);
    setState(DEFAULT_THEME);
    stateRef.current = DEFAULT_THEME;
    // The density editor holds its own variant, so a pristine theme has to
    // bring it back too — otherwise Reset leaves it pointed at the old variant,
    // warning about a mismatch that no longer exists.
    setDensityVariant(DEFAULT_THEME.density);
    setApplied(null);
    setAiNote(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* nothing to clear */ }
  }

  /** Pinned under the scroll body by `Drawer` — the panel's own actions, plus
   *  whatever the last apply had to say about it. */
  const footer = (
    <>
      {applied && !applied.linked && (
        <p style={{ ...note, marginTop: 0 }}>
          The theme module is written, but this example builds its grid in a shape the panel does
          not recognise — add it by hand:{" "}
          <code style={code}>{manualImportHint(getFiles())}</code>
        </p>
      )}
      {googleFontFamily(state.params.fontFamily) && (
        <p style={{ ...note, marginTop: 0 }}>
          Loading <strong>{googleFontFamily(state.params.fontFamily)}</strong> from Google Fonts —
          the theme module adds the stylesheet link, so the font travels with the demo.
        </p>
      )}
      <div style={{ display: "flex", gap: ui.space(2), flexWrap: "wrap" }}>
        <button type="button" style={ghost} onClick={() => setShowCode((v) => !v)}>
          {showCode ? "Hide code" : "Copy for my app"}
        </button>
        <button type="button" style={ghost} onClick={reset} disabled={pristine}>
          Reset
        </button>
        {/* `textMuted`, not `success`. The literal `#1a8f5a` this replaced was a
            colour no token carries, and the obvious swap is wrong: `success`
            (#37bc6c) lands at ~2.3:1 on light `surfaceMuted`, worse than the
            literal and well under AA for 12px text. This line is status, not a
            warning — muted is what the rest of the panel's meta uses. */}
        {applied && <span style={{ ...note, margin: 0, alignSelf: "center" }}>Applied to the preview</span>}
      </div>
      {showCode && (
        <>
          <p style={{ ...note, marginTop: ui.space(2), marginBottom: ui.space(1) }}>
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
    </>
  );

  return (
    <Drawer
      title="Style this demo"
      onClose={onClose}
      subheader={
        <nav style={tabBar} role="tablist" aria-label="Style panel sections">
          {([
            ["foundation", "Foundation"],
            ["common", "Common"],
            ["component", "Component"],
            ["ai", "AI"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="hot-panel-tab"
              aria-selected={tab === key}
              style={tabBtn(tab === key)}
              onClick={() => { setTab(key); if (key !== "component") setComponent(null); }}
            >
              {label}
            </button>
          ))}
        </nav>
      }
      footer={footer}
    >
      <div>
        <p style={intro}>
          The same theme controls as{" "}
          <a href="https://theme-builder.handsontable.com/" target="_blank" rel="noreferrer" style={{ color: ui.color.accentText }}>
            Theme Builder
          </a>
          , applied to the example you have open. The theme is written into the demo as{" "}
          <code style={code}>{themeModulePath(getFiles())}</code> and handed to the grid, so it
          travels with a download or a share.
        </p>

        {tab === "ai" && (
        <Section title="Describe a style">
          <form
            style={{ display: "flex", gap: ui.space(2) }}
            onSubmit={(e) => { e.preventDefault(); void describe(prompt); }}
          >
            <input
              type="text"
              style={control}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="retro terminal, corporate blue, dark and compact…"
              maxLength={300}
              disabled={thinking}
              aria-label="Describe the style you want"
            />
            <button type="submit" style={{ ...ghost, opacity: thinking || !prompt.trim() ? 0.5 : 1 }} disabled={thinking || !prompt.trim()}>
              {thinking ? "…" : "Style"}
            </button>
          </form>
          {aiNote && <div style={sectionNote}>{aiNote}</div>}
          <p style={{ ...note, marginTop: ui.space(3), marginBottom: 0 }}>
            Describes the whole theme at once — presets, ramps and tokens. Everything it
            sets shows up in the other tabs, where you can nudge it by hand.
          </p>
        </Section>
        )}

        {/* Which version's defaults are on screen (DEV-2560). Only shown once the
            load has settled: it would otherwise flash on every panel open, and
            again whenever `/api/versions` repoints a `next` stamp. */}
        {!loadingPresets && presets.fallback && (
          <div style={{ ...sectionNote, margin: `0 ${ui.space(4)} ${ui.space(2)}` }}>
            Showing Handsontable {presets.version}&rsquo;s defaults — {htVersion}&rsquo;s could not
            be loaded. Overrides you set are unaffected.
          </div>
        )}
        {loadingPresets && (
          <div style={{ ...sectionNote, margin: `0 ${ui.space(4)} ${ui.space(2)}` }}>
            Resolving Handsontable {htVersion} defaults&hellip;
          </div>
        )}

        {tab === "foundation" && (<>
        <Section title="Token mapping">
          {/* Tiles, not a dropdown: the three token presets differ in how the
              grid *looks*, which a thumbnail conveys and the word "horizon"
              does not. Same call theme-builder's FoundationTab makes. */}
          <div style={tileRow}>
            {TOKENS_PRESETS.map((preset) => (
              <Tile
                key={preset}
                label={preset}
                image={`/theme-tiles/tokens/${preset}.png`}
                active={state.tokens === preset}
                onClick={() => update({ tokens: preset })}
              />
            ))}
          </div>
        </Section>

        <Section title="Icons set">
          <div style={{ ...tileRow, justifyContent: "flex-start" }}>
            {ICONS_PRESETS.map((preset) => (
              <Tile
                key={preset}
                label={preset}
                image={`/theme-tiles/icons/${preset}.png`}
                active={state.icons === preset}
                onClick={() => update({ icons: preset })}
                maxWidth={90}
              />
            ))}
          </div>
          <div style={sectionNote}>
            Icons change the grid's arrows, menu and sort marks — watch the preview.
          </div>
        </Section>

        <Section title="Preset">
          <Select
            label="Colors"
            value={state.colors}
            options={COLORS_PRESETS}
            onChange={(v) => update({ colors: v as ThemeState["colors"] })}
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

        <section style={{ borderTop: `1px solid ${ui.color.border}` }}>
          <button
            type="button"
            className="hot-panel-row"
            style={groupHeader}
            onClick={() => setOpenGroup(openGroup === "Palette" ? "" : "Palette")}
            aria-expanded={openGroup === "Palette"}
          >
            <GroupLabel label="Palette" open={openGroup === "Palette"} />
            {Object.keys(state.palette).length > 0 && <span style={badge}>{Object.keys(state.palette).length}</span>}
          </button>
          {openGroup === "Palette" && (
            <div style={{ padding: BODY_PAD }}>
              <p style={{ ...note, marginTop: 0 }}>
                The ramps the tokens derive from. Recolouring the brand here beats overriding a
                dozen tokens one at a time.
              </p>
              <label style={row}>
                <span style={rowLabel}>Brand colour</span>
                <span style={{ display: "flex", gap: ui.space(1), flex: 1 }}>
                  <input
                    type="color"
                    aria-label="Generate the brand ramp from this colour"
                    value={brandColour}
                    onChange={(e) => rampFrom(e.target.value)}
                    style={swatch}
                  />
                  <button type="button" style={{ ...ghost, flex: 1 }} onClick={() => rampFrom(brandColour)}>
                    Generate all six steps
                  </button>
                </span>
              </label>
              <div style={sectionTitle}>Primary</div>
              <Ramp steps={PRIMARY_STEPS} prefix="primary" state={state} colors={ctx.colors} onChange={setPalette} />
              <div style={sectionTitle}>Neutral</div>
              <Ramp steps={NEUTRAL_STEPS} prefix="palette" state={state} colors={ctx.colors} onChange={setPalette} />
              <div style={sectionTitle}>Base</div>
              {["white", "black"].map((key) => (
                <TokenField
                  key={key}
                  token={{ key, label: key[0]!.toUpperCase() + key.slice(1), type: "color", description: "" }}
                  value={state.palette[key] ?? ""}
                  resolved={String(ctx.colors[key] ?? "")}
                  overridden={state.palette[key] !== undefined}
                  onChange={(v) => setPalette(key, v)}
                  onReset={() => setPalette(key, "")}
                />
              ))}
            </div>
          )}
        </section>

        <section style={{ borderTop: `1px solid ${ui.color.border}` }}>
          <button
            type="button"
            className="hot-panel-row"
            style={groupHeader}
            onClick={() => setOpenGroup(openGroup === "Density sizes" ? "" : "Density sizes")}
            aria-expanded={openGroup === "Density sizes"}
          >
            <GroupLabel label="Density sizes" open={openGroup === "Density sizes"} />
            {densitySizeCount(state) > 0 && <span style={badge}>{densitySizeCount(state)}</span>}
          </button>
          {openGroup === "Density sizes" && (
            <div style={{ padding: BODY_PAD }}>
              <p style={{ ...note, marginTop: 0 }}>
                Fine-tune a density preset one measurement at a time. Each row shows what the
                preset resolves to; pick or type another value to override it, and Reset puts
                it back. All three variants are editable, so a theme still behaves when the
                grid is switched between them.
              </p>
              {/* Which variant is being edited — independent of the one the grid is
                  set to, exactly as theme-builder's density modal allows. */}
              <div style={segmentedRow}>
                {DENSITY_VARIANTS.map((v) => {
                  const n = Object.keys(state.densitySizes[v] ?? {}).length;
                  return (
                    <button
                      key={v}
                      type="button"
                      style={segmentBtn(densityVariant === v)}
                      onClick={() => setDensityVariant(v)}
                    >
                      {v}{n > 0 ? ` (${n})` : ""}
                    </button>
                  );
                })}
              </div>
              {densityVariant !== state.density && (
                <div style={{ ...sectionNote, marginBottom: ui.space(2) }}>
                  Editing <strong>{densityVariant}</strong>; the grid is currently on{" "}
                  <strong>{state.density}</strong>, so these won't show in the preview yet.
                </div>
              )}
              {DENSITY_GROUPS.map((group) => (
                <div key={group.label}>
                  <div style={subGroup}>{group.label}</div>
                  {group.tokens.map((token) => (
                    <DensitySizeControl
                      key={token.key}
                      token={token}
                      ctx={ctx}
                      value={state.densitySizes[densityVariant]?.[token.key]}
                      resolved={resolvedDensitySize(token.key)}
                      effectiveRef={editedDensity[token.key] ?? ""}
                      onChange={(v) => setDensitySize(densityVariant, token.key, v)}
                      onReset={() => setDensitySize(densityVariant, token.key, "")}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
        </>)}

        {tab === "common" && (
          <div style={{ padding: BODY_PAD }}>
            <p style={{ ...note, marginTop: 0 }}>
              The tokens the whole grid is built from — change one here and it carries
              everywhere the components reference it.
            </p>
            {COMMON_SECTIONS.map((section) => (
              <div key={section.label}>
                <div style={sectionTitle}>{section.label}</div>
                {section.groups.flatMap((g) => g.tokens).map(tokenRow)}
              </div>
            ))}
          </div>
        )}

        {tab === "component" && (
          component === null ? (
            /* The component list. A flat list of 243 tokens would be unusable, so
               picking a component opens its own sub-panel — theme-builder's second
               column, stacked instead of side-by-side because 420px has no room
               for two. */
            <div style={{ padding: BODY_PAD }}>
              <p style={{ ...note, marginTop: 0 }}>
                Per-component tokens. Pick a part of the grid to style it on its own.
              </p>
              {COMPONENT_SECTIONS.map((section) => {
                const set = overrideCount(section.groups.flatMap((g) => g.tokens));
                return (
                  <button
                    key={section.label}
                    type="button"
                    className="hot-panel-row"
                    style={componentRow}
                    // Test contract (DEV-2203): a stable accessible name. The
                    // computed name otherwise concatenates the override badge
                    // ("Header 2"), so a role query breaks the moment a token
                    // is overridden — and "Buttons" collides with "Radio
                    // Buttons" without an exact match to hang it on.
                    aria-label={section.label}
                    onClick={() => setComponent(section.label)}
                  >
                    <span>{section.label}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: ui.space(2) }}>
                      {set > 0 && <span style={badge}>{set}</span>}
                      <IconChevronRight size={14} style={{ color: ui.color.textMuted }} />
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: BODY_PAD }}>
              <button type="button" style={backBtn} onClick={() => setComponent(null)}>
                <IconChevronLeft size={14} />
                All components
              </button>
              {COMPONENT_SECTIONS.filter((s) => s.label === component).map((section) => (
                <div key={section.label}>
                  <div style={sectionTitle}>{section.label}</div>
                  {section.description && <p style={{ ...note, marginTop: 0 }}>{section.description}</p>}
                  {section.groups.map((group) => (
                    <div key={group.label}>
                      {group.label && <div style={subGroup}>{group.label}</div>}
                      {group.tokens.map(tokenRow)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </Drawer>
  );
}

/** A preset as a picture. Ported from theme-builder's `ButtonBox`: the tiles
 *  are thumbnails of what the preset does to a grid, which is the only honest
 *  way to choose between "main" and "horizon" without applying both. */
function Tile({
  label,
  image,
  active,
  onClick,
  maxWidth,
}: {
  label: string;
  image: string;
  active: boolean;
  onClick: () => void;
  maxWidth?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      // The selection ring used to be an accent `borderColor` *and* a 1px accent
      // `boxShadow` on top of it — the same line drawn twice, and neither on the
      // shell's shadow scale. The border alone is the signal now, and it lives in
      // `.hot-swatch-btn` so the hover can reach it (ADR-0026).
      className="hot-panel-tile"
      data-active={active}
      style={{ ...tile, ...(maxWidth ? { maxWidth } : {}) }}
    >
      <img src={image} alt="" style={tileImg} />
      <span style={{ ...tileLabel, color: active ? ui.color.accentText : ui.color.textMuted }}>
        {label}
      </span>
    </button>
  );
}

/** A collapsible group's header text: the shell's small-caps section type with
 *  the disclosure chevron leading it, in place of the old `▾`/`▸` glyphs. */
function GroupLabel({ label, open }: { label: string; open: boolean }) {
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: ui.space(2) }}>
      <Chevron size={14} style={{ color: ui.color.textMuted }} />
      {label}
    </span>
  );
}

/** A colour ramp as a row of swatches — the shape of the ramp is the thing
 *  worth seeing, and eleven stacked text fields hide it.
 *
 *  Each swatch paints the *effective* colour: the override where there is one,
 *  the preset's own step where there is not (DEV-2560). It used to paint white
 *  at 35% opacity until a step was overridden, so a freshly opened panel read as
 *  eleven identical grey squares — "nie wygladaja jak by dzialaly". The hex is
 *  in the tooltip; theme-builder's own modal lists it, and eleven text fields
 *  next to eleven pickers do not fit a 400px drawer.
 *
 *  Because opacity no longer says which steps are overridden, an accent outline
 *  does, and the per-ramp Reset is how an override comes back off — clearing by
 *  emptying a field is not available on a colour input. */
function Ramp({
  steps,
  prefix,
  state,
  colors,
  onChange,
}: {
  steps: readonly string[];
  prefix: string;
  state: ThemeState;
  /** The effective colours — preset with the panel's palette layered on. */
  colors: ColorsMap;
  onChange: (key: string, value: string) => void;
}) {
  const overridden = steps.filter((step) => state.palette[`${prefix}.${step}`] !== undefined);

  return (
    <div style={{ marginBottom: ui.space(3) }}>
      <div style={{ display: "flex", gap: ui.space(1), flexWrap: "wrap" }}>
        {steps.map((step) => {
          const key = `${prefix}.${step}`;
          const override = state.palette[key];
          const resolved = String(getNestedValue(colors, key) ?? "");
          const effective = override ?? resolved;
          return (
            <label
              key={key}
              style={{ textAlign: "center" }}
              title={`${key} — ${effective || "unset"}${override ? "" : " (theme default)"}`}
            >
              <input
                type="color"
                aria-label={key}
                value={hexInputValue(effective, "#ffffff")}
                onChange={(e) => onChange(key, e.target.value)}
                style={{
                  ...swatch,
                  width: 26,
                  flex: "0 0 26px",
                  border: `${override ? 2 : 1}px solid ${override ? ui.color.accent : ui.color.controlBorder}`,
                  // A fully transparent preset colour normalises to white, which
                  // would read as an opaque swatch — the chequer says otherwise.
                  backgroundImage: isTransparentHex(effective)
                    ? "linear-gradient(45deg, rgba(128,128,128,.4) 25%, transparent 25% 75%, rgba(128,128,128,.4) 75%)"
                    : undefined,
                  backgroundSize: "8px 8px",
                }}
              />
              <div style={{ fontSize: 10, color: ui.color.textMuted }}>{step}</div>
            </label>
          );
        })}
      </div>
      {overridden.length > 0 && (
        <button
          type="button"
          style={{ ...ghost, marginTop: ui.space(2), fontSize: 12 }}
          // Not the bare word "Reset": the panel footer has one of those, and a
          // second exact match makes every `name: "Reset", exact: true` locator
          // ambiguous.
          aria-label={`Reset the ${prefix} ramp`}
          onClick={() => { for (const step of overridden) onChange(`${prefix}.${step}`, ""); }}
        >
          Reset ramp ({overridden.length})
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: `${ui.space(2)} ${ui.space(4)} ${ui.space(3)}` }}>
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
 *  `transparent`, a CSS variable or an rgba() are all still expressible.
 *
 *  `value` is the override and nothing else — the preset's value shows as the
 *  *placeholder* (DEV-2560). Binding it into `value` would be the tempting
 *  version and the wrong one twice over: the field would stop distinguishing a
 *  default from an override, and the first keystroke would commit the whole
 *  resolved value as one. Empty stays the override signal, which is what keeps
 *  `isPristine`, the group badges and the generated module honest. */
function TokenField({
  token,
  value,
  resolved,
  overridden,
  onChange,
  onReset,
}: {
  token: Token;
  /** The override, or `""` when this token has none. */
  value: string;
  /** What it comes out as without an override — shown as the placeholder. */
  resolved?: string;
  overridden?: boolean;
  onChange: (value: string) => void;
  onReset?: () => void;
}) {
  return (
    <div style={{ marginBottom: ui.space(2) }} data-token={token.key}>
      <label style={row}>
        <span style={rowLabel} title={token.key}>{token.label}</span>
        <span style={{ display: "flex", gap: ui.space(1), flex: 1 }}>
          {token.type === "color" && (
            <input
              type="color"
              aria-label={`${token.label} colour picker`}
              value={hexInputValue(value || resolved)}
              onChange={(e) => onChange(e.target.value)}
              style={swatch}
            />
          )}
          <input
            type="text"
            value={value}
            placeholder={resolved || "theme default"}
            onChange={(e) => onChange(e.target.value)}
            style={control}
          />
        </span>
        {overridden && onReset && (
          // `aria-label`, not the bare word: the footer's Reset is the one an
          // exact-name locator means, and this must not collide with it.
          <button type="button" style={resetLink} aria-label={`Reset ${token.key}`} onClick={onReset}>
            Reset
          </button>
        )}
      </label>
      {token.description && <div style={hint}>{token.description}</div>}
    </div>
  );
}

/**
 * The toolbar entry point, with the same hover CTA as "Ask AI".
 *
 * "Style" alone reads like a formatting toggle. The tooltip is the only place
 * someone learns before clicking that this is the whole of Theme Builder, that
 * it writes a real module into the demo rather than a throwaway preview, and
 * that a sentence of English is a valid way to drive it.
 *
 * `disabled` keeps the button on screen and repurposes that tooltip to say why
 * (DEV-2560). A toolbar entry that vanishes on some versions reads as a bug and
 * explains nothing, and the reason — the demo's core has no theme API — is not
 * something anyone would guess.
 */
export function StyleButton({ open, onToggle, disabled = false, disabledReason }: {
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [hint, setHint] = useState(false);
  // Not over the panel it opens: once that is up the tooltip only repeats what
  // the user can already read. Disabled, there is no panel, so it always shows.
  const show = hint && (disabled || !open);

  return (
    <span
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}
      onMouseEnter={() => setHint(true)}
      onMouseLeave={() => setHint(false)}
    >
      <button
        type="button"
        // Kept focusable while disabled so the tooltip is reachable by keyboard —
        // `aria-disabled` says it does nothing, and the click handler agrees.
        style={disabled ? { ...styleBtn, opacity: 0.5, cursor: "not-allowed" } : styleBtn}
        onClick={() => { if (!disabled) onToggle(); }}
        onFocus={() => setHint(true)}
        onBlur={() => setHint(false)}
        onKeyDown={(e) => { if (e.key === "Escape") setHint(false); }}
        aria-pressed={open}
        aria-disabled={disabled || undefined}
        aria-describedby={show ? "style-hint" : undefined}
      >
        <IconPalette />
        Style
      </button>

      {show && (
        <span id="style-hint" role="tooltip" style={tooltip}>
          {disabled ? (
            <>
              <strong style={{ display: "block", marginBottom: ui.space(1) }}>Not available here</strong>
              <span style={{ display: "block", color: ui.color.textMuted }}>{disabledReason}</span>
            </>
          ) : (
            <>
              <strong style={{ display: "block", marginBottom: ui.space(1) }}>Restyle this example</strong>
              <span style={{ display: "block", color: ui.color.textMuted, marginBottom: ui.space(2) }}>
                Everything Theme Builder does, applied to the demo you have open.
              </span>
              <span style={tooltipItem}>272 tokens — colours, sizes, typography, per component</span>
              <span style={tooltipItem}>“Retro amber terminal” — describe it and the grid becomes it</span>
              <span style={tooltipItem}>Presets, brand ramp, light/dark and density</span>
              <span style={{ display: "block", marginTop: ui.space(2), color: ui.color.textMuted }}>
                Written into the demo as a real module, so it survives Download and Share — and
                Reset puts everything back.
              </span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

export const STYLE_PANEL_TOKENS = ALL_TOKENS.length;

// ---- Styles ------------------------------------------------------------------
//
// The panel chrome — fixed drawer, header, close button, footer band — is gone
// from here: it is `Drawer` in the shell now, shared with the chat panel
// (DEV-2209). What is left is this panel's own contents, on the shell's scales:
// `space(n)` for padding, `radius.sm|md|lg` (there is no 5 or 6), and 18/13/12/10
// for type. `controlBorder` on anything that has to read as a control outline —
// dark `border` *is* `surfaceRaised`, which is what the drawer is painted with.

/** The label column of a `row`, and the indent its hint has to match. One
 *  constant, because they were 130 and 138 by hand and could drift apart. */
const ROW_LABEL_WIDTH = 130;

/** The inset every section in the body shares. */
const BODY_PAD = `0 ${ui.space(4)} ${ui.space(3)}`;

const sectionTitle: React.CSSProperties = { ...headerLabel, display: "block", marginBottom: ui.space(2) };
// No inline `background` — `.hot-panel-row` owns the fill and its rollover (ADR-0026).
const groupHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
  border: "none", cursor: "pointer", padding: `${ui.space(2)} ${ui.space(4)}`,
  fontFamily: ui.font.ui, fontSize: 13, color: ui.color.text, textAlign: "left",
};
const badge: React.CSSProperties = {
  background: ui.color.accent, color: ui.color.accentContrast, borderRadius: 999,
  fontSize: 10, lineHeight: "16px", padding: `0 ${ui.space(2)}`, fontWeight: 600,
};
const row: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: ui.space(2), marginBottom: ui.space(2),
};
const rowLabel: React.CSSProperties = {
  width: ROW_LABEL_WIDTH, flex: `0 0 ${ROW_LABEL_WIDTH}px`, fontSize: 13,
};
const control: React.CSSProperties = {
  flex: 1, minWidth: 0, fontFamily: ui.font.ui, fontSize: 13,
  padding: `${ui.space(1)} ${ui.space(2)}`,
  border: `1px solid ${ui.color.controlBorder}`, borderRadius: ui.radius.sm,
  color: ui.color.text, background: ui.color.surface,
};
const swatch: React.CSSProperties = {
  width: 30, flex: "0 0 30px", padding: 0, height: 26,
  border: `1px solid ${ui.color.controlBorder}`, borderRadius: ui.radius.sm,
  background: ui.color.surface, cursor: "pointer",
};
/** The inline "Reset" beside an overridden field — the same affordance the token
 *  rows carry in `theme/controls.tsx`, on the same `accentText`. */
const resetLink: React.CSSProperties = {
  border: "none", background: "none", color: ui.color.accentText, fontSize: 12,
  cursor: "pointer", padding: `0 ${ui.space(1)}`, flex: "0 0 auto",
};
/** Sits under a control, so it indents past the label column to line up with it. */
const hint: React.CSSProperties = {
  fontSize: 12, color: ui.color.textMuted, marginLeft: ROW_LABEL_WIDTH + 8,
};
/** The same muted line, but explaining a *section* rather than one control — so no
 *  label column to clear, and a real gap above it. Three call sites used to reach
 *  for `hint` and cancel its indent by hand; the one under the icon tiles didn't,
 *  which left the sentence indented under nothing and 4px off the tiles. */
const sectionNote: React.CSSProperties = {
  fontSize: 12, color: ui.color.textMuted, marginTop: ui.space(2),
};
/** Matches the "Ask AI" tooltip so the two toolbar CTAs read as a pair. */
const tooltip: React.CSSProperties = {
  position: "absolute", top: `calc(100% + ${ui.space(2)})`, left: 0, zIndex: 950, width: 320,
  background: ui.color.surfaceRaised, border: `1px solid ${ui.color.controlBorder}`,
  borderRadius: ui.radius.md, boxShadow: ui.shadow.popover,
  padding: `${ui.space(2)} ${ui.space(3)}`,
  fontFamily: ui.font.ui, fontSize: 12, color: ui.color.text,
  textAlign: "left", whiteSpace: "normal", cursor: "default",
};
const tooltipItem: React.CSSProperties = { display: "block", padding: `${ui.space(1)} 0` };
const segmentedRow: React.CSSProperties = { display: "flex", gap: ui.space(1), marginBottom: ui.space(2) };
const segmentBtn = (on: boolean): React.CSSProperties => ({
  flex: 1, fontSize: 12, padding: `${ui.space(1)} 0`, cursor: "pointer", borderRadius: ui.radius.sm,
  textTransform: "capitalize", fontFamily: ui.font.ui,
  border: `1px solid ${on ? ui.color.accent : ui.color.controlBorder}`,
  background: on ? ui.color.accent : ui.color.surface, color: on ? ui.color.accentContrast : ui.color.text,
});
const tileRow: React.CSSProperties = { display: "flex", gap: ui.space(2), justifyContent: "space-between" };
/** No `border-color`: `.hot-panel-tile` carries resting, hover and selected, or
 *  an inline colour would outrank the rollover (ADR-0026 §2 — the shorthand
 *  counts too, hence width and style being set on their own here). It rests on
 *  `controlBorder`, unlike the colour chips' `.hot-swatch-btn`: a framed thumbnail
 *  without its frame reads as a floating image. */
const tile: React.CSSProperties = {
  flex: 1, minWidth: 0, padding: ui.space(1), borderRadius: ui.radius.md, cursor: "pointer",
  borderWidth: 1, borderStyle: "solid", background: ui.color.surface,
  display: "flex", flexDirection: "column", alignItems: "center", gap: ui.space(1),
  // A `<button>` with no `color` takes the UA's `buttontext` — black in both
  // modes, which is the same class of miss as the `buttonface` fill in ADR-0026 §3.
  fontFamily: ui.font.ui, color: ui.color.text,
};
const tileImg: React.CSSProperties = {
  width: "100%", height: "auto", display: "block", borderRadius: ui.radius.sm,
};
const tileLabel: React.CSSProperties = { fontSize: 12, textTransform: "capitalize" };
const tabBar: React.CSSProperties = {
  display: "flex", borderBottom: `1px solid ${ui.color.border}`, flex: "0 0 auto",
  padding: `0 ${ui.space(2)}`, background: ui.color.surfaceRaised,
};
// No inline `background` — `.hot-panel-tab` owns it. The accent underline stays
// here: no rule touches `border-bottom-color`, so it cannot be outranked.
const tabBtn = (on: boolean): React.CSSProperties => ({
  flex: 1, padding: `${ui.space(2)} ${ui.space(1)}`, fontSize: 13, cursor: "pointer",
  border: "none", borderBottom: `2px solid ${on ? ui.color.accent : "transparent"}`,
  color: on ? ui.color.accentText : ui.color.textMuted, fontWeight: on ? 600 : 400,
  fontFamily: ui.font.ui,
});
// Same split as `groupHeader`: the fill and its rollover live in `.hot-panel-row`.
const componentRow: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
  padding: `${ui.space(2)} ${ui.space(1)}`, fontSize: 13, cursor: "pointer",
  border: "none", borderBottom: `1px solid ${ui.color.border}`,
  color: ui.color.text, fontFamily: ui.font.ui, textAlign: "left",
};
const backBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: ui.space(1),
  border: "none", background: "none", color: ui.color.accentText, fontSize: 13,
  cursor: "pointer", padding: `${ui.space(2)} 0`, fontFamily: ui.font.ui,
};
const subGroup: React.CSSProperties = { ...headerLabel, display: "block", margin: `${ui.space(3)} 0 ${ui.space(2)}` };
const note: React.CSSProperties = { fontSize: 12, color: ui.color.textMuted, margin: `0 0 ${ui.space(3)}` };
/** The panel's opening blurb. It sits directly in the scroll body rather than
 *  inside a Section, so it has to bring its own padding — without it the text
 *  runs edge to edge while everything below it is inset. */
const intro: React.CSSProperties = {
  ...note, padding: `${ui.space(3)} ${ui.space(4)} 0`, margin: `0 0 ${ui.space(1)}`,
};
const code: React.CSSProperties = {
  fontFamily: ui.font.mono, fontSize: "0.92em", background: ui.color.surface,
  border: `1px solid ${ui.color.controlBorder}`, borderRadius: ui.radius.sm,
  padding: `0 ${ui.space(1)}`,
};
const pre: React.CSSProperties = {
  background: ui.color.editorBg, color: ui.color.text, borderRadius: ui.radius.md,
  padding: ui.space(2), overflowX: "auto", fontFamily: ui.font.mono, fontSize: 12,
  margin: `0 0 ${ui.space(2)}`, maxHeight: 220,
  border: `1px solid ${ui.color.controlBorder}`,
};
const ghost: React.CSSProperties = {
  fontFamily: ui.font.ui, fontSize: 13, background: ui.color.surface, color: ui.color.text,
  border: `1px solid ${ui.color.controlBorder}`, borderRadius: ui.radius.sm,
  padding: `${ui.space(1)} ${ui.space(3)}`, cursor: "pointer",
};
// The two live in the redesigned 72px top bar, which is `surfaceRaised` and has a
// dark mode. `#fff` and `border` were both fine on the pre-redesign bar; on this one
// `#fff` is a white block in dark, and dark `border` *is* `surfaceRaised`, so the
// outline disappears. Transparent + `controlBorder` is the bar's own idiom (ADR-0028).
const styleBtn: React.CSSProperties = {
  // Metrics match the bar's own `actionButton` (36px, `radius.md`, 13/600): these sit
  // between the mode action and the theme toggle, and the old bar's 26px pill read as
  // a leftover beside them. The `🎨` this used to lead with is now `IconPalette`
  // (DEV-2209): an emoji renders in the OS's own colour and weight, so it was the one
  // mark on the bar that could not follow the theme.
  display: "inline-flex", alignItems: "center", gap: ui.space(2),
  height: 36, padding: `0 ${ui.space(3)}`, flex: "0 0 auto",
  fontFamily: ui.font.ui, fontSize: 13, fontWeight: 600,
  background: "transparent", color: ui.color.text,
  border: `1px solid ${ui.color.controlBorder}`, borderRadius: ui.radius.md,
  cursor: "pointer", whiteSpace: "nowrap",
};
