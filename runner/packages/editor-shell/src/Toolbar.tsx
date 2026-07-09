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
  /** Create an embeddable (docs-only) version from the current playground code. */
  onEmbed?: () => void;
  embedding?: boolean;
  /** Signed in? Save/Share/custom-version/Fork are shown only when true. */
  authed: boolean;
  /** "play" (playground -> Fork), "edit" (saved demo -> Save/Share), or
   *  "share" (read-only public playground -> no actions, version locked). */
  mode?: "play" | "edit" | "share";
  sharing?: boolean;
  saving?: boolean;
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
  onEmbed,
  embedding,
  authed,
  mode = "play",
  sharing,
  saving,
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

      {/* The version is locked on the read-only share playground. */}
      {mode === "share" ? (
        <span style={{ fontSize: 12, color: "#647382" }}>Handsontable {version}</span>
      ) : (
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
      )}

      {/* Actions are for signed-in internal users only. Anonymous visitors just
          browse/edit/preview and sign in from the top bar. */}
      {authed && mode === "edit" && (
        <>
          <button type="button" style={s.button} onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : dirty ? "Save •" : "Save"}
          </button>
          <button
            type="button"
            style={{ ...s.button, ...s.buttonPrimary }}
            onClick={onShare}
            title="Get the public client link and docs embed URL"
          >
            Share
          </button>
        </>
      )}

      {authed && mode === "play" && (
        <>
          {onEmbed && (
            <button
              type="button"
              style={s.button}
              onClick={onEmbed}
              disabled={embedding}
              title="Create an embeddable (docs-only) version and copy its embed URL"
            >
              {embedding ? "Preparing…" : "Embed"}
            </button>
          )}
          <button
            type="button"
            style={{ ...s.button, ...s.buttonPrimary }}
            onClick={onFork}
            disabled={sharing}
            title="Fork this demo into your own editable, shareable client demo"
          >
            {sharing ? "Creating…" : "Fork this demo"}
          </button>
        </>
      )}
    </header>
  );
}
