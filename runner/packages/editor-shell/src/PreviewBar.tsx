// The preview column's 36px bar (`72:15706`): refresh · URL · version ·
// framework · book · github · window-maximize.
//
// The version and framework pills, and the docs/repo links, render only when
// they apply — `48:6560` (a saved demo) shows the bar with refresh, URL and
// maximize alone. That conditionality already existed in the app; the redesign
// changes the form, not the rule (ADR-0023).

import { useState } from "react";
import {
  IconBook,
  IconBrandGithub,
  IconBrandReactNative,
  IconRefresh,
  IconWindowMaximize,
} from "./icons/index.js";
import { MenuButton } from "./MenuButton.js";
import { s } from "./styles.js";
import { theme } from "./theme.js";

export interface FrameworkChoice {
  /** Opaque to the shell — handed back to `onSelect` verbatim. */
  key: string;
  label: string;
  active: boolean;
}

export interface PreviewBarProps {
  /** The demo's public URL, when it has one. Preferred over `previewUrl`. */
  publicUrl?: string;
  /** Where the iframe is actually pointed (Tier 2); blank for Tier 1. */
  previewUrl?: string;
  onRefresh?: () => void;
  /** Open the preview full-window (`?mode=full`). */
  onMaximize?: () => void;

  version: string;
  versionOptions: string[];
  onVersionChange: (v: string) => void;
  /** Read-only version, no picker — the share playground pins its version. */
  versionLocked?: boolean;
  versionWarning?: string | null;

  frameworks?: FrameworkChoice[];
  onFrameworkChange?: (key: string) => void;

  docsUrl?: string;
  repoUrl?: string;
  repoLabel?: string;
}

export function PreviewBar({
  publicUrl,
  previewUrl,
  onRefresh,
  onMaximize,
  version,
  versionOptions,
  onVersionChange,
  versionLocked,
  versionWarning,
  frameworks,
  onFrameworkChange,
  docsUrl,
  repoUrl,
  repoLabel,
}: PreviewBarProps) {
  const url = publicUrl || previewUrl || "";
  const [copied, setCopied] = useState(false);
  const options = versionOptions.includes(version) ? versionOptions : [version, ...versionOptions];
  const activeFramework = frameworks?.find((f) => f.active);

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
    <div style={s.bar}>
      {onRefresh && (
        <button
          type="button"
          className="hot-icon-btn"
          style={s.iconButton}
          onClick={onRefresh}
          aria-label="Reload the preview"
          title="Reload the preview"
        >
          <IconRefresh />
        </button>
      )}

      {/* Read-only: this reports where the preview lives, it is not an address
          bar. Tier 1 has no meaningful URL (Sandpack renders into the iframe
          without navigating), so it falls back to a placeholder. */}
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

      {versionWarning && (
        <span
          style={{ color: theme.color.warning, fontSize: 12, maxWidth: 260, flex: "0 0 auto" }}
          title={versionWarning}
        >
          {versionWarning}
        </span>
      )}

      {versionLocked ? (
        <span style={{ ...s.menuButton, cursor: "default", color: theme.color.textMuted }}>
          Handsontable {version}
        </span>
      ) : (
        <MenuButton
          ariaLabel="Handsontable version"
          options={options.map((v) => ({ value: v, label: v }))}
          value={version}
          onSelect={onVersionChange}
        >
          <span style={{ color: theme.color.textMuted }}>Handsontable</span>
          <span>{version}</span>
        </MenuButton>
      )}

      {frameworks && frameworks.length > 0 && onFrameworkChange && (
        <MenuButton
          ariaLabel="Framework"
          options={frameworks.map((f) => ({ value: f.key, label: f.label }))}
          value={activeFramework?.key ?? ""}
          onSelect={onFrameworkChange}
        >
          <IconBrandReactNative />
          <span>{activeFramework?.label ?? "Framework"}</span>
        </MenuButton>
      )}

      {docsUrl && (
        <a
          className="hot-icon-btn"
          style={s.iconButton}
          href={docsUrl}
          target="_blank"
          rel="noreferrer"
          aria-label="Open the documentation page for this example"
          title="Open the documentation page for this example"
        >
          <IconBook />
        </a>
      )}

      {repoUrl && (
        <a
          className="hot-icon-btn"
          style={s.iconButton}
          href={repoUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={repoLabel ?? "View this example's source on GitHub"}
          title={repoLabel ?? "View this example's source on GitHub"}
        >
          <IconBrandGithub />
        </a>
      )}

      {onMaximize && (
        <button
          type="button"
          className="hot-icon-btn"
          style={s.iconButton}
          onClick={onMaximize}
          aria-label="Open the preview full-window"
          title="Open the preview full-window"
        >
          <IconWindowMaximize />
        </button>
      )}
    </div>
  );
}
