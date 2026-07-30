import { useState } from "react";
import { theme, useTheme } from "@handsontable/demo-editor-shell";
import type { FilesMap } from "@handsontable/demo-runtime";

export interface ShareResult {
  id: string;
  viewUrl: string;
  embedUrl: string;
}

export interface ShareDialogProps {
  apiBase: string;
  framework: string;
  files: FilesMap;
  version: string;
  forkedFrom: string | null;
  token: string | null;
  initialResult: ShareResult | null;
  onResult: (r: ShareResult) => void;
  onClose: () => void;
}

/** Fork -> title/description -> build -> permanent /d/:id link + docs embed URL.
 *  Only reachable from the authenticated authoring app, so generating/copying
 *  the embed URL is inherently internal-only (ADR-0009). */
export function ShareDialog(props: ShareDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShareResult | null>(props.initialResult);
  const [copied, setCopied] = useState<"" | "view" | "embed">("");
  const { mode: themeMode } = useTheme();

  async function create() {
    if (!title.trim()) { setError("Please add a title."); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${props.apiBase}/api/demos`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
        },
        body: JSON.stringify({
          framework: props.framework,
          files: props.files,
          title: title.trim(),
          description: description.trim() || undefined,
          htVersion: props.version,
          forkedFrom: props.forkedFrom ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `share failed (${res.status})`);
      }
      const data = (await res.json()) as { id: string; url: string; embedUrl: string };
      const r: ShareResult = {
        id: data.id,
        viewUrl: `${props.apiBase}${data.url}`,
        // Preferred-theme hint, same as App.tsx's embedUrl (ADR-0022).
        embedUrl: `${props.apiBase}${data.embedUrl}?theme=${themeMode}`,
      };
      setResult(r);
      props.onResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(kind: "view" | "embed", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* clipboard blocked; user can select manually */
    }
  }

  return (
    <Overlay onClose={props.onClose}>
      <h2 style={{ fontFamily: theme.font.ui, fontSize: 18, margin: "0 0 4px" }}>Share this demo</h2>
      <p style={{ color: theme.color.textMuted, fontFamily: theme.font.ui, fontSize: 13, marginTop: 0 }}>
        Snapshots the current code, builds a permanent static page, and gives you a link to send a client.
      </p>

      {!result ? (
        <>
          <label style={label}>Title</label>
          <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Ant Design theme for Acme" autoFocus />
          <label style={label}>Description (optional)</label>
          <textarea style={{ ...input, height: 72, resize: "vertical" }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this demo shows" />
          {error && <p style={errorText}>{error}</p>}
          <div style={row}>
            <button style={ghost} onClick={props.onClose}>Cancel</button>
            <button style={primary} onClick={create} disabled={busy}>{busy ? "Building…" : "Create link"}</button>
          </div>
        </>
      ) : (
        <>
          <LinkRow label="Client link" value={result.viewUrl} copied={copied === "view"} onCopy={() => copy("view", result.viewUrl)} />
          <LinkRow label="Docs embed URL (handsontable.com only)" value={result.embedUrl} copied={copied === "embed"} onCopy={() => copy("embed", result.embedUrl)} />
          <div style={row}>
            <a style={{ ...ghost, textDecoration: "none", textAlign: "center" }} href={result.viewUrl} target="_blank" rel="noreferrer">Open</a>
            <button style={primary} onClick={props.onClose}>Done</button>
          </div>
        </>
      )}
    </Overlay>
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

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>{children}</div>
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
const errorText: React.CSSProperties = { color: theme.color.danger, fontSize: 13, margin: "8px 0 0" };
