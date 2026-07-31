// Editor status bar, built to frame `31:6618`.
//
// Four segments in a 24px-gap flex row. The `·` in the ticket and the redesign
// plan is prose shorthand for those gaps — the frame draws no separators.
//
// Only Ln/Col is live. The other three are static: CodeMirror's `tabSize` facet
// reports the CM6 default rather than the design's 2, and `indentUnit` — the
// extension that would make the label true — lives in `@codemirror/language`,
// which `@uiw/react-codemirror` does not re-export. Encoding and keyboard layout
// have no source at all in a browser editor.

import type { CSSProperties } from "react";
import { s } from "./styles.js";

export interface EditorStatusBarProps {
  /** 1-based caret line. */
  line: number;
  /** 1-based caret column. */
  col: number;
}

export function EditorStatusBar({ line, col }: EditorStatusBarProps) {
  return (
    <div style={bar} aria-label="Editor status">
      {/* Not `role="status"`/`aria-live` — that would announce every caret move. */}
      <span>
        Ln {line}, Col {col}
      </span>
      <span>Spaces: 2</span>
      <span>UTF-8</span>
      <span>Layout: U.S.</span>
    </div>
  );
}

// The band itself is `s.paneStatusBar`, shared with `PreviewStatusBar` — that shared
// object is what keeps the two bars flush across the editor/preview boundary, as the
// frames draw them. It is on `editorBg`, not `surfaceMuted`: measured #ffffff / #19191c
// off the frames, the same token the editor pane already uses, so the bar reads as part
// of the editor rather than as a separate strip (open item 7). Only the 24px segment
// gap is this bar's own.
const bar: CSSProperties = { ...s.paneStatusBar, gap: 24 };
