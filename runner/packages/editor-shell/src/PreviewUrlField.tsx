// The read-only preview address (`72:15710` / `65:20491`), click-to-copy.
//
// Extracted from `PreviewBar` because T8's full-mode bar is refresh · this field ·
// minimize, and the field is the only element the two bars share. It reports where
// the preview lives — it is not an address bar, and nothing here navigates.

import { useState } from "react";
import { s } from "./styles.js";

export interface PreviewUrlFieldProps {
  /** Blank is a valid state: Tier 1 has no URL to report (Sandpack renders into
   *  the iframe without navigating), and the field falls back to a placeholder. */
  url: string;
}

export function PreviewUrlField({ url }: PreviewUrlFieldProps) {
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure origin / permission) — nothing to fall back to */
    }
  }

  return (
    <button
      type="button"
      style={{ ...s.urlField, cursor: url ? "pointer" : "default" }}
      onClick={copyUrl}
      disabled={!url}
      title={url ? "Copy this URL" : undefined}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontStyle: url ? "normal" : "italic",
        }}
      >
        {copied ? "Copied" : url || "Live preview"}
      </span>
    </button>
  );
}
