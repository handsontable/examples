import { s } from "./styles.js";
import logoUrl from "./logo.svg";

export interface ToolbarProps {
  frameworkLabel: string;
  version: string;
  versionOptions: string[];
  onVersionChange: (v: string) => void;
  onSave: () => void;
  onShare: () => void;
  onFork: () => void;
  /** Signed in? Save/Share/custom-version are shown only when true. */
  authed: boolean;
  sharing?: boolean;
  shareUrl?: string | null;
  dirty?: boolean;
}

export function Toolbar({
  frameworkLabel,
  version,
  versionOptions,
  onVersionChange,
  onSave,
  onShare,
  onFork,
  authed,
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
        <img src={logoUrl} alt="Handsontable" style={{ height: 22, display: "block" }} />
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
        {authed && (
          <input
            style={{ ...s.select, width: 240 }}
            defaultValue=""
            placeholder="custom (e.g. 0.0.0-next-07941cf-…)"
            aria-label="Custom Handsontable version"
            title="Type any published version or a pkg.pr.new build, then press Enter"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value.trim();
                if (v) onVersionChange(v);
              }
            }}
          />
        )}
      </label>

      {authed ? (
        <>
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
        </>
      ) : (
        <button
          type="button"
          style={{ ...s.button, ...s.buttonPrimary }}
          onClick={onFork}
          title="Sign in to fork this example into your own shareable demo"
        >
          Fork this demo
        </button>
      )}
    </header>
  );
}
