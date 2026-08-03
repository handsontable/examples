// The preview column's 36px bar (`72:15706`): refresh · URL · version (+ custom
// pencil) · framework · share · book · github · window-maximize.
//
// The version and framework pills, and the docs/repo links, render only when
// they apply — `48:6560` (a saved demo) shows the bar with refresh, URL and
// maximize alone. That conditionality already existed in the app; the redesign
// changes the form, not the rule (ADR-0023).
//
// `share` and the version pencil arrived with T10 (ADR-0025), which retired the
// unframed authed action bar: the After Login frames give both a home here.

import { useState } from "react";
import {
  IconBook,
  IconBrandGithub,
  IconBrandReactNative,
  IconPencil,
  IconRefresh,
  IconShare,
  IconWindowMaximize,
} from "./icons/index.js";
import { MenuButton } from "./MenuButton.js";
import { PreviewUrlField } from "./PreviewUrlField.js";
import { Spinner } from "./Spinner.js";
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
  /** Show the pencil that swaps the pill for a free-text version field
   *  (`114:24396`). Signed-in only, so `EditorShell` resolves it. */
  versionEditable?: boolean;

  frameworks?: FrameworkChoice[];
  onFrameworkChange?: (key: string) => void;

  /** Open the share dialog. Mode-aware upstream: in `edit` it shows the saved
   *  demo's links, in `play` it mints the demo first (what the old `Embed`
   *  button did) and shows the same dialog. Signed-in only. */
  onShare?: () => void;
  /** A `play`-mode mint is in flight. */
  sharing?: boolean;

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
  versionEditable,
  frameworks,
  onFrameworkChange,
  onShare,
  sharing,
  docsUrl,
  repoUrl,
  repoLabel,
}: PreviewBarProps) {
  const url = publicUrl || previewUrl || "";
  const options = versionOptions.includes(version) ? versionOptions : [version, ...versionOptions];
  const activeFramework = frameworks?.find((f) => f.active);
  const [editingVersion, setEditingVersion] = useState(false);

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

      <PreviewUrlField url={url} />

      {/* The bar is a fixed 36px and both warning strings run ~90 characters, so
          this has to clamp to one line — left to wrap it pushes itself out of the
          bar and over whatever is below. The full text stays reachable through
          `title`. The design budgets no room for a warning here at all; the
          placement question is DEV-2173. */}
      {versionWarning && (
        <span
          style={{
            color: theme.color.warning,
            fontSize: 12,
            flex: "0 1 auto",
            minWidth: 0,
            maxWidth: 320,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={versionWarning}
        >
          {versionWarning}
        </span>
      )}

      {versionLocked ? (
        <span style={{ ...s.menuButton, cursor: "default", color: theme.color.textMuted }}>
          Handsontable {version}
        </span>
      ) : editingVersion ? (
        /* The old bar's 260px `custom version` input, folded into the pill's own
           footprint (`114:24396` widens the pill frame 161→181 to hold it). Any
           published version or a pkg.pr.new build; the picker's own options stay
           reachable by leaving the field. */
        <input
          autoFocus
          style={customVersion}
          defaultValue={version}
          aria-label="Custom Handsontable version"
          title="Type any published version or a pkg.pr.new build, then press Enter"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const v = e.currentTarget.value.trim();
              setEditingVersion(false);
              if (v && v !== version) onVersionChange(v);
            } else if (e.key === "Escape") {
              setEditingVersion(false);
            }
          }}
          onBlur={() => setEditingVersion(false)}
        />
      ) : (
        <>
          <MenuButton
            ariaLabel="Handsontable version"
            options={options.map((v) => ({ value: v, label: v }))}
            value={version}
            onSelect={onVersionChange}
          >
            <span style={{ color: theme.color.textMuted }}>Handsontable</span>
            <span>{version}</span>
          </MenuButton>

          {/* Sibling of the pill, not of its chevron: the chevron is the last child
              of `MenuButton`'s trigger, whose only job is toggling the listbox, so a
              pencil nested before it would open the menu on every click. `s.menuButton`
              draws no border, so a button immediately after still reads as part of
              the pill. */}
          {versionEditable && (
            <button
              type="button"
              className="hot-icon-btn"
              style={s.iconButton}
              onClick={() => setEditingVersion(true)}
              aria-label="Set a custom Handsontable version"
              title="Set a custom Handsontable version"
            >
              <IconPencil />
            </button>
          )}
        </>
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

      {/* Heads the right icon group in 3 of 4 After Login frames (`tabler-icon-share`,
          audit A3). No `Embed` button anywhere: in `play` this mints the demo and
          opens the very dialog `Embed` opened, whose third row is the docs embed URL. */}
      {onShare && (
        <button
          type="button"
          className="hot-icon-btn"
          style={sharing ? { ...s.iconButton, cursor: "default" } : s.iconButton}
          onClick={onShare}
          disabled={sharing}
          aria-label={sharing ? "Preparing…" : "Share this demo"}
          title={sharing ? "Preparing…" : "Get the public client link and docs embed URL"}
        >
          {sharing ? <Spinner size={16} /> : <IconShare />}
        </button>
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

/** The width the frame gives the widened pill (`114:24396`). It replaces the pill
 *  *and* the pencil, which rest at 204px together, so opening the field pulls the
 *  icons right of it in by 7px — visible only if you are looking for it, and the
 *  alternative is padding the field to a number no frame asks for. */
const customVersion: React.CSSProperties = {
  width: 181,
  height: 26,
  flex: "0 0 auto",
  margin: `0 ${theme.space(2)}`,
  padding: `0 ${theme.space(2)}`,
  borderRadius: theme.radius.md,
  border: `1px solid ${theme.color.border}`,
  background: theme.color.surface,
  color: theme.color.text,
  fontFamily: theme.font.mono,
  fontSize: 12,
  boxSizing: "border-box",
};
