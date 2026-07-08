import { s } from "./styles.js";

export interface ToolbarProps {
  frameworkLabel: string;
  version: string;
  versionOptions: string[];
  onVersionChange: (v: string) => void;
  onSave: () => void;
  onShare: () => void;
  sharing?: boolean;
  shareUrl?: string | null;
  dirty?: boolean;
}

/** Handsontable "H" mark — inline SVG, our logo only. No third-party marks. */
function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="4" fill="#1a8f5a" />
      <path d="M7 6v12M17 6v12M7 12h10" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Toolbar({
  frameworkLabel,
  version,
  versionOptions,
  onVersionChange,
  onSave,
  onShare,
  sharing,
  shareUrl,
  dirty,
}: ToolbarProps) {
  const options = versionOptions.includes(version)
    ? versionOptions
    : [version, ...versionOptions];
  return (
    <header style={s.toolbar}>
      <div style={s.brand}>
        <Logo />
        <span>Handsontable Demos</span>
      </div>
      <span style={s.frameworkTag}>{frameworkLabel}</span>

      <div style={s.spacer} />

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
        <span style={{ color: "#647382" }}>Handsontable</span>
        <select
          style={s.select}
          value={version}
          onChange={(e) => onVersionChange(e.target.value)}
          aria-label="Handsontable version"
        >
          {options.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>

      <button type="button" style={s.button} onClick={onSave}>
        {dirty ? "Save •" : "Save"}
      </button>
      <button
        type="button"
        style={{ ...s.button, ...s.buttonPrimary }}
        onClick={onShare}
        disabled={sharing}
      >
        {sharing ? "Sharing…" : "Share"}
      </button>

      {shareUrl && (
        <a style={s.shareLink} href={shareUrl} target="_blank" rel="noreferrer" title={shareUrl}>
          {shareUrl}
        </a>
      )}
    </header>
  );
}
