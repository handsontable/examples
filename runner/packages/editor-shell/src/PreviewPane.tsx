import { useState, type CSSProperties } from "react";
import { IconChevronDown, IconChevronRight } from "./icons/index.js";
import { Spinner } from "./Spinner.js";
import { s } from "./styles.js";
import { theme } from "./theme.js";

export type PreviewStatus = "booting" | "ready" | "error";

export interface PreviewPaneProps {
  /** Callback ref: the parent binds its DemoRuntime to this iframe. */
  iframeRef: (el: HTMLIFrameElement | null) => void;
  status: PreviewStatus;
  errorMessage?: string | null;
  /** Live boot log for Tier-2 container sessions (shown while booting). */
  bootLog?: string;
  /** This preview boots a real dev server (Tier 2): the wait is tens of seconds and a
   *  log will follow, so the boot overlay explains itself. Tier 1 compiles in-browser in
   *  about a second and gets the designed spinner alone.
   *
   *  Deliberately a flag rather than `!!bootLog`: the log only starts arriving once the
   *  session POST returns, and that request is exactly what stalls when the container
   *  pool is full — the window where the explanation matters most is the window where
   *  there is no log to infer it from. */
  containerBoot?: boolean;
  /** A container rebuild is in flight after an edit. */
  syncing?: boolean;
  /** A row-2 refresh is in flight (`72:26445`). */
  refreshing?: boolean;
}

/** Clean a raw boot log into a few readable recent lines.
 *
 *  `ContainerRuntime.emitProgress` streams the log **raw** — its own `\x1b` strip is on
 *  the failure path only (`container.ts:228`), so escapes arrive here intact. The old
 *  pattern was `/\[[0-9;]*m/`, missing the ESC byte: it left an orphan `\x1b` behind
 *  every colour code and would eat a literal `[31m` out of ordinary text. That was
 *  survivable while the log lived in a collapsed block; T5 promotes the newest line to
 *  an always-visible single row, where the artefacts show.
 *
 *  Full CSI, not just colour (`m`): pnpm and vite emit erase-line and cursor-move codes
 *  (`\x1b[2K`, `\x1b[1G`) as they redraw progress, and those are exactly what a boot log
 *  is full of. Carriage returns get the same treatment — a progress line rewritten with
 *  `\r` should read as whatever it ended up as, not as every frame concatenated. */
function tailLines(log: string, n = 12): string {
  return log
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .map((l) => l.slice(l.lastIndexOf("\r") + 1).trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join("\n");
}

/** The single preview-iframe slot. Identical for Tier 1 (Sandpack drives the
 *  iframe) and Tier 2 (iframe.src = container preview URL) — the shell never
 *  knows which engine is behind it.
 *
 *  Every overlay is `inset: 0`, so it covers the iframe and nothing else: the readiness
 *  readout is `PreviewStatusBar`, a *sibling* of this section in the preview column, and
 *  it therefore stays visible in all four states. `72:26445` shows exactly that — a
 *  blanked pane with the bar still reading `● ready`. */
export function PreviewPane({
  iframeRef,
  status,
  errorMessage,
  bootLog,
  containerBoot,
  syncing,
  refreshing,
}: PreviewPaneProps) {
  const booting = status === "booting";
  const failed = status === "error";
  const log = bootLog ? tailLines(bootLog) : "";
  // A refresh blanks the pane, so the badge would be describing work on an empty
  // surface that the refresh spinner is already describing.
  const showSyncing = status === "ready" && syncing && !refreshing;
  return (
    // `data-preview-status` is the machine-readable readiness signal. It used to be the
    // text of a coloured strip at the top of the pane, which the starter matrix polled
    // for "Live"; T2 removed the strip and T5 moved the readout to the bottom bar. An
    // attribute keeps the signal out of the chrome entirely, so restyling can never
    // break the suite again. Both it and `aria-label` are a test contract
    // (`e2e/starter-matrix.spec.ts:144`, `e2e/docs-examples.spec.ts:305`) — leave them,
    // and leave the iframe a descendant of this section.
    <section style={s.previewPane} aria-label="Preview" data-preview-status={status}>
      {showSyncing && (
        <div style={syncPill}>
          <Spinner onAccent />
          Applying changes…
        </div>
      )}

      {booting && (
        <div style={overlay}>
          <Spinner size={20} />
          <p style={headline}>Loading data …</p>
          {/* The design draws only the spinner and that headline, and that is all a
              Tier-1 boot gets — it compiles in about a second. The live install /
              dev-server log is a gap in the design rather than a removal: it is the only
              signal when a container is slow or stuck, so a Tier-2 boot keeps it. */}
          {containerBoot && <BootLog log={log} />}
        </div>
      )}

      {failed && errorMessage && (
        // No frame exists for the error state, so T9's rule applies: rebuild it against
        // the token set, to dev judgment.
        <div style={overlay}>
          <div style={errorCard}>
            <p style={errorTitle}>The preview could not start</p>
            <pre style={errorBody}>{errorMessage}</pre>
          </div>
        </div>
      )}

      {status === "ready" && refreshing && (
        // `previewBg`, not `surface`: the frame blanks the pane to the surround colour
        // rather than layering a panel over it.
        <div style={{ ...overlay, background: theme.color.previewBg }}>
          <Spinner size={20} />
        </div>
      )}

      <iframe
        ref={iframeRef}
        title="Demo preview"
        style={s.previewIframe}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </section>
  );
}

/** What the wait is, the newest log line, and the tail behind a disclosure.
 *
 *  The caption renders before any log arrives — the session POST is what stalls when the
 *  container pool is full, and that is precisely when the user needs to be told the wait
 *  is expected. `Preparing container…` stands in for the live line until the first
 *  progress arrives, so the block never renders half-empty.
 *
 *  A button and a chevron rather than `<details>`/`<summary>`: hiding the native marker
 *  needs `list-style: none` *and* `::-webkit-details-marker { display: none }`, both
 *  pseudo-element rules that inline styles cannot express — and `editor-shell` may not
 *  reach into the consuming app's global stylesheet. `FileTree` already uses these two
 *  icons for the same job. */
function BootLog({ log }: { log: string }) {
  const [open, setOpen] = useState(false);
  const last = log ? log.slice(log.lastIndexOf("\n") + 1) : "Preparing container…";
  return (
    <div style={logBlock}>
      <p style={caption}>
        Starting the live dev server — first load installs dependencies and can take a minute…
      </p>
      <span style={liveLine} title={last}>
        {last}
      </span>
      {log && (
        <>
          <button
            type="button"
            style={detailsButton}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? <IconChevronDown /> : <IconChevronRight />}
            Details
          </button>
          {open && <pre style={logTail}>{log}</pre>}
        </>
      )}
    </div>
  );
}

/** Covers the iframe only — `PreviewStatusBar` sits outside this section. */
const overlay: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: theme.space(2),
  padding: theme.space(4),
  overflow: "auto",
  background: theme.color.surface,
  fontFamily: theme.font.ui,
  color: theme.color.text,
};

const headline: CSSProperties = { margin: 0, fontSize: 13 };

const syncPill: CSSProperties = {
  position: "absolute",
  top: theme.space(3),
  right: theme.space(3),
  zIndex: 3,
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  padding: "4px 10px",
  borderRadius: theme.radius.md,
  background: theme.color.accent,
  color: theme.color.accentContrast,
  fontFamily: theme.font.ui,
  fontSize: 12,
  boxShadow: theme.shadow.sm,
};

const logBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: theme.space(2),
  width: "100%",
  maxWidth: 560,
  minWidth: 0,
};

const caption: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: theme.color.textMuted,
  textAlign: "center",
};

const liveLine: CSSProperties = {
  maxWidth: "100%",
  fontFamily: theme.font.mono,
  fontSize: 12,
  color: theme.color.textMuted,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const detailsButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: `2px ${theme.space(2)}`,
  border: "none",
  borderRadius: theme.radius.sm,
  background: "transparent",
  color: theme.color.textMuted,
  fontFamily: theme.font.ui,
  fontSize: 12,
  cursor: "pointer",
};

const logTail: CSSProperties = {
  margin: 0,
  width: "100%",
  maxHeight: 220,
  overflow: "auto",
  padding: theme.space(2),
  borderRadius: theme.radius.sm,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surfaceSunken,
  fontFamily: theme.font.mono,
  fontSize: 12,
  color: theme.color.textMuted,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  textAlign: "left",
};

const errorCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: theme.space(2),
  width: "100%",
  maxWidth: 560,
  minWidth: 0,
  padding: theme.space(4),
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.dangerBorder}`,
  background: theme.color.surface,
};

const errorTitle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: theme.color.danger,
};

const errorBody: CSSProperties = {
  margin: 0,
  maxHeight: 240,
  overflow: "auto",
  fontFamily: theme.font.mono,
  fontSize: 12,
  color: theme.color.textMuted,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
