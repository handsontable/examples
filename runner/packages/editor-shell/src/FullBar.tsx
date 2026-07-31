// The full-mode bar (`65:20487`): refresh · URL · window-minimize. Three elements,
// and that is the whole frame — no version pill, no framework pill, no docs or repo
// link. Those belong to a workspace, and full mode has none: it is the built demo
// on its own (`65:20432`).
//
// Not `PreviewBar` with optional props: that component's version trigger is
// required by construction (T2), and the two bars share exactly one element, which
// `PreviewUrlField` now owns.

import { IconRefresh, IconWindowMinimize } from "./icons/index.js";
import { PreviewUrlField } from "./PreviewUrlField.js";
import { s } from "./styles.js";

export interface FullBarProps {
  /** The demo's public address — `/share/:id`, as the frame draws it. */
  url: string;
  /** Reloads the built demo in place. */
  onRefresh: () => void;
  /** Leaves full mode (drops `?mode=full`); `65:20496`. */
  onMinimize: () => void;
}

export function FullBar({ url, onRefresh, onMinimize }: FullBarProps) {
  return (
    <div style={s.bar}>
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

      <PreviewUrlField url={url} />

      <button
        type="button"
        className="hot-icon-btn"
        style={s.iconButton}
        onClick={onMinimize}
        aria-label="Leave full-window view"
        title="Leave full-window view"
      >
        <IconWindowMinimize />
      </button>
    </div>
  );
}
