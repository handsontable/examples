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
  /** A container rebuild is in flight after an edit. */
  syncing?: boolean;
}

const STATUS_TEXT: Record<PreviewStatus, string> = {
  booting: "Booting preview…",
  ready: "Live",
  error: "Error",
};

/** Clean a raw boot log into a few readable recent lines. */
function tailLines(log: string, n = 12): string {
  return log
    .replace(/\[[0-9;]*m/g, "") // strip ANSI colors
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join("\n");
}

/** The single preview-iframe slot. Identical for Tier 1 (Sandpack drives the
 *  iframe) and Tier 2 (iframe.src = container preview URL) — the shell never
 *  knows which engine is behind it. While a Tier-2 container boots, the live
 *  install/dev-server log is shown so it never looks frozen. */
export function PreviewPane({ iframeRef, status, errorMessage, bootLog, syncing }: PreviewPaneProps) {
  const booting = status === "booting";
  const failed = status === "error";
  const log = bootLog ? tailLines(bootLog) : "";
  return (
    <section style={s.previewPane} aria-label="Preview">
      <div style={s.statusBar(status)}>
        {STATUS_TEXT[status]}
        {status === "error" ? ": Setup failed" : ""}
      </div>

      {status === "ready" && syncing && (
        <div
          style={{
            position: "absolute",
            top: 36,
            right: 12,
            zIndex: 3,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: theme.color.accent,
            color: "#fff",
            fontFamily: theme.font.ui,
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 999,
            boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
          }}
        >
          <Spinner light />
          Applying changes…
        </div>
      )}

      {booting && (
        <div
          style={{
            position: "absolute",
            inset: "28px 0 0 0",
            background: theme.color.surface,
            padding: 16,
            overflow: "auto",
            fontFamily: theme.font.mono,
            fontSize: 12,
            color: theme.color.textMuted,
            zIndex: 2,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, color: theme.color.text }}>
            <Spinner />
            <span style={{ fontFamily: theme.font.ui, fontSize: 13 }}>
              Starting the live dev server — first load installs dependencies and can take a minute…
            </span>
          </div>
          {log ? (
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{log}</pre>
          ) : (
            <span>Preparing container…</span>
          )}
        </div>
      )}

      {failed && errorMessage && (
        <div
          style={{
            position: "absolute",
            inset: "28px 0 0 0",
            background: theme.color.surface,
            padding: 16,
            overflow: "auto",
            fontFamily: theme.font.mono,
            fontSize: 12,
            color: theme.color.textMuted,
            zIndex: 2,
          }}
        >
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{errorMessage}</pre>
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

function Spinner({ light }: { light?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: light ? 11 : 14,
        height: light ? 11 : 14,
        border: `2px solid ${light ? "rgba(255,255,255,0.4)" : theme.color.border}`,
        borderTopColor: light ? "#fff" : theme.color.accent,
        borderRadius: "50%",
        display: "inline-block",
        animation: "hot-spin 0.8s linear infinite",
      }}
    >
      <style>{`@keyframes hot-spin{to{transform:rotate(360deg)}}`}</style>
    </span>
  );
}
