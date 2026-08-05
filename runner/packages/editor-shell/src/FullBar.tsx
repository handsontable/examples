// The full-mode bar (`65:20487`): refresh · URL · window-minimize. Three elements,
// and that is the whole frame — no version pill, no framework pill, no docs or repo
// link (`65:20432`).
//
// Those controls act on a workspace, and full mode is the view without one to act on:
// over a saved demo it shows the finished `/d/:id/` build, and in `play` it shows the
// live preview with the editor put away (ADR-0027 §13). Either way, changing the
// version or the framework is something you leave full mode to do.
//
// Not `PreviewBar` with optional props: that component's version trigger is
// required by construction (T2), and the two bars share exactly one element, which
// `PreviewUrlField` now owns.

import { IconRefresh, IconWindowMinimize } from "./icons/index.js";
import { PreviewUrlField } from "./PreviewUrlField.js";
import { s } from "./styles.js";

export interface FullBarProps {
  /** The demo's public address — `/share/:id`, as the frame draws it. Blank in `play`,
   *  where `PreviewUrlField` falls back to its `Live preview` placeholder. */
  url: string;
  /** Reloads the built demo (or, in `play`, the live preview) in place. Optional for
   *  the same reason `PreviewBar`'s is: a bar with a button that does nothing is
   *  worse than a bar one icon short. */
  onRefresh?: () => void;
  /** Leaves full mode (drops `?mode=full`); `65:20496`. */
  onMinimize: () => void;
}

export function FullBar({ url, onRefresh, onMinimize }: FullBarProps) {
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
