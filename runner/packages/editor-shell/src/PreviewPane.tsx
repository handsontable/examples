import { s } from "./styles.js";

export type PreviewStatus = "booting" | "ready" | "error";

export interface PreviewPaneProps {
  /** Callback ref: the parent binds its DemoRuntime to this iframe. */
  iframeRef: (el: HTMLIFrameElement | null) => void;
  status: PreviewStatus;
  errorMessage?: string | null;
}

const STATUS_TEXT: Record<PreviewStatus, string> = {
  booting: "Booting preview…",
  ready: "Live",
  error: "Error",
};

/** The single preview-iframe slot. Identical for Tier 1 (Sandpack drives the
 *  iframe) and Tier 2 (iframe.src = container preview URL) — the shell never
 *  knows which engine is behind it. */
export function PreviewPane({ iframeRef, status, errorMessage }: PreviewPaneProps) {
  return (
    <section style={s.previewPane} aria-label="Preview">
      <div style={s.statusBar(status)}>
        {STATUS_TEXT[status]}
        {status === "error" && errorMessage ? `: ${errorMessage}` : ""}
      </div>
      <iframe
        ref={iframeRef}
        title="Demo preview"
        style={s.previewIframe}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      />
    </section>
  );
}
