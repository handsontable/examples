import { useState } from "react";
import { theme } from "@handsontable/demo-editor-shell";

/** Post-save share dialog for a saved demo: the public client link + the
 *  docs-only embed URL, each copyable. (Login-gated by virtue of only being
 *  reachable from the authenticated edit page — ADR-0009.) */
export function ShareLinks({
  clientUrl,
  embedUrl,
  onClose,
}: {
  clientUrl: string;
  embedUrl: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"" | "client" | "full" | "embed">("");
  const fullUrl = `${clientUrl}?mode=full`;
  async function copy(kind: "client" | "full" | "embed", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* clipboard blocked; user can select manually */
    }
  }
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontFamily: theme.font.ui, fontSize: 18, margin: "0 0 4px" }}>Share this demo</h2>
        <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui, fontSize: 13, marginTop: 0 }}>
          The client link is public. The full-window link is example-only and iframe-embeddable anywhere; the docs embed URL only renders inside handsontable.com docs.
        </p>
        <LinkRow label="Client link (public, editable view)" value={clientUrl} copied={copied === "client"} onCopy={() => copy("client", clientUrl)} />
        <LinkRow label="Full-window (example only — embed in any iframe)" value={fullUrl} copied={copied === "full"} onCopy={() => copy("full", fullUrl)} />
        <LinkRow label="Docs embed URL (handsontable.com only)" value={embedUrl} copied={copied === "embed"} onCopy={() => copy("embed", embedUrl)} />
        <div style={row}>
          <a style={{ ...ghost, textDecoration: "none", textAlign: "center" }} href={clientUrl} target="_blank" rel="noreferrer">Open</a>
          <button style={primary} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function LinkRow({ label: l, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div style={{ margin: "10px 0" }}>
      <label style={label}>{l}</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input style={{ ...input, fontFamily: theme.font.mono, fontSize: 12 }} value={value} readOnly onFocus={(e) => e.currentTarget.select()} />
        <button style={ghost} onClick={onCopy}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: theme.color.scrim,
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};
const modal: React.CSSProperties = {
  width: 460, maxWidth: "92vw", background: theme.color.surfaceRaised, borderRadius: 12,
  padding: 24, boxShadow: theme.shadow.dialog, fontFamily: theme.font.ui,
  color: theme.color.text,
};
const label: React.CSSProperties = { display: "block", fontSize: 12, color: theme.color.textMuted, margin: "10px 0 4px" };
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", fontFamily: theme.font.ui, fontSize: 14,
  padding: "8px 10px", border: `1px solid ${theme.color.border}`, borderRadius: 8,
  background: theme.color.surface, color: theme.color.text,
};
const row: React.CSSProperties = { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 };
const ghost: React.CSSProperties = {
  fontFamily: theme.font.ui, fontSize: 13, border: `1px solid ${theme.color.border}`,
  background: theme.color.surface, color: theme.color.text, borderRadius: 8,
  padding: "8px 14px", cursor: "pointer",
};
const primary: React.CSSProperties = { ...ghost, border: `1px solid ${theme.color.accent}`, background: theme.color.accent, color: theme.color.accentContrast, fontWeight: 600 };
