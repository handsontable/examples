import { useState } from "react";
import { Dialog, IconCopy, theme } from "@handsontable/demo-editor-shell";

/** Post-save share dialog for a saved demo, built to `114:23289`.
 *
 *  Three labelled read-only fields, each with the copy affordance *inside* the
 *  field rather than a button beside it. The frame drops the explanatory
 *  paragraph and the Open/Done footer the pre-redesign dialog had — the close
 *  affordance is the title row's X, which `Dialog` owns.
 *
 *  (Login-gated by virtue of only being reachable from the authenticated edit
 *  page — ADR-0009.) */
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
      /* clipboard blocked; the field is selectable, so the user can still copy by hand */
    }
  }

  return (
    <Dialog title="Share this demo" onClose={onClose}>
      <LinkRow
        label="Public client link:"
        value={clientUrl}
        copied={copied === "client"}
        onCopy={() => copy("client", clientUrl)}
      />
      {/* The frame labels this row "example only — embed in any iframe". Both halves
          are false, so the copy is not taken from it (ADR-0027 §10):
            * `?mode=full` stopped being bare in T8 — it carries the design's chrome
              (top bar, URL bar, status bar) around the built demo.
            * It cannot be embedded anywhere. The page iframes `/d/:id/`, which sends
              `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` (`share.ts`),
              so a third-party ancestor blocks the inner demo.
          The chrome-less, genuinely embeddable surface is the docs embed below. */}
      <LinkRow
        label="Full-window (the demo without the editor)"
        value={fullUrl}
        copied={copied === "full"}
        onCopy={() => copy("full", fullUrl)}
      />
      <LinkRow
        label="Docs embed URL (handsontable.com only)"
        value={embedUrl}
        copied={copied === "embed"}
        onCopy={() => copy("embed", embedUrl)}
      />
    </Dialog>
  );
}

function LinkRow({
  label: l,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div style={row}>
      <label style={label}>{l}</label>
      <div style={field}>
        <input
          style={input}
          value={value}
          readOnly
          aria-label={l}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="hot-icon-btn"
          style={copyButton(copied)}
          onClick={onCopy}
          // The frame gives the button no label and no copied state — it's an icon
          // in a field. Both live here instead, where a screen reader can reach them.
          aria-label={`Copy ${l.replace(/[:(].*$/, "").trim().toLowerCase()}`}
          title={copied ? "Copied" : "Copy"}
        >
          <IconCopy />
        </button>
      </div>
    </div>
  );
}

const row: React.CSSProperties = { marginBottom: theme.space(4) };

const label: React.CSSProperties = {
  display: "block",
  marginBottom: theme.space(2),
  fontSize: 13,
  color: theme.color.text,
};

const field: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(1),
  padding: `0 ${theme.space(1)} 0 ${theme.space(3)}`,
  border: `1px solid ${theme.color.border}`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceSunken,
};

const input: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 32,
  border: "none",
  outline: "none",
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.mono,
  fontSize: 12,
  textOverflow: "ellipsis",
};

// No inline `background` — it would outrank `.hot-icon-btn:hover` (ADR-0026).
// The copied state is carried by colour, which nothing in the stylesheet sets.
const copyButton = (copied: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  flex: "0 0 auto",
  padding: 0,
  border: "none",
  borderRadius: theme.radius.sm,
  color: copied ? theme.color.success : theme.color.textMuted,
  cursor: "pointer",
});
