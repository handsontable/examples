// The description editor (DEV-2507): a toolbar and a preview over a markdown
// textarea.
//
// "WYSIWYG" here means you never type syntax and you can see the result — not a
// contenteditable surface. The stored value has to stay markdown text (a D1 `TEXT`
// column rendered in the sidebar, on the demo card and on the shared page), and a
// rich-text surface needs its own document model, paste sanitising and selection
// handling. The ticket says so out loud rather than implying otherwise.
//
// Every transform lives in `markdownActions.ts` and is unit-tested there; this
// file is the wiring: which buttons exist, where the caret lands afterwards, and
// the preview.

import { useRef, useState, type CSSProperties } from "react";
import { theme } from "@handsontable/demo-editor-shell";
import { Markdown } from "./markdown.js";
import { actionForShortcut, applyMarkdownAction, type MarkdownAction } from "./markdownActions.js";
import { fieldLabel, fieldTextarea } from "./formStyles.js";

/** Mirrors the Worker's cap so the field can show it; the server is the authority. */
export const MAX_DESCRIPTION = 4000;

const BUTTONS: { action: MarkdownAction; label: string; title: string; style?: CSSProperties }[] = [
  { action: "bold", label: "B", title: "Bold (⌘B)", style: { fontWeight: 700 } },
  { action: "italic", label: "I", title: "Italic (⌘I)", style: { fontStyle: "italic" } },
  { action: "code", label: "‹›", title: "Code" },
  // A word, not an emoji: the other glyphs are typographic (B, I, ‹›, 1.) and one
  // colour emoji among them reads as a foreign object — and it is the one control
  // whose shape says nothing about what it does.
  { action: "link", label: "Link", title: "Link" },
  { action: "bulletList", label: "• —", title: "Bullet list" },
  { action: "numberedList", label: "1.", title: "Numbered list" },
  { action: "heading", label: "H", title: "Heading" },
];

export interface MarkdownFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
}

export function MarkdownField({ id, label, value, onChange, rows = 6 }: MarkdownFieldProps) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(false);
  const overLimit = value.length > MAX_DESCRIPTION;

  /** Run an action against the live selection, then put the caret back where the
   *  action asked for it — the field keeps focus, so the next action composes. */
  function run(action: MarkdownAction) {
    const area = areaRef.current;
    if (!area) return;
    const next = applyMarkdownAction(action, {
      value,
      selectionStart: area.selectionStart,
      selectionEnd: area.selectionEnd,
    });
    onChange(next.value);
    // After the controlled re-render: React writes `value`, and a selection set
    // before that write would be clobbered by it.
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  }

  return (
    <div>
      <div style={header}>
        <label style={{ ...fieldLabel, margin: 0 }} htmlFor={id}>
          {label}
        </label>
        <div style={toolbar}>
          {BUTTONS.map(({ action, label: glyph, title, style }) => (
            <button
              key={action}
              type="button"
              // `title` *and* `aria-label`: the glyphs are not words, so a screen
              // reader needs the name and a mouse user wants the hint.
              title={title}
              aria-label={title}
              className="hot-icon-btn"
              style={{ ...toolButton, ...(glyph.length > 2 ? wordButton : null), ...style }}
              // The textarea must not lose the selection to the button.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(action)}
              disabled={preview}
            >
              {glyph}
            </button>
          ))}
          <button
            type="button"
            style={{ ...toolButton, width: "auto", padding: `0 ${theme.space(2)}` }}
            aria-pressed={preview}
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? "Write" : "Preview"}
          </button>
        </div>
      </div>

      {preview ? (
        // Rendered by the same component the demo pages use, so the preview is the
        // result rather than an approximation of it.
        <div style={previewBox} data-testid="description-preview">
          {value.trim()
            ? <Markdown text={value} />
            : <p style={{ margin: 0, color: theme.color.textMuted }}>Nothing to preview yet.</p>}
        </div>
      ) : (
        <textarea
          id={id}
          ref={areaRef}
          style={{ ...fieldTextarea, minHeight: rows * 20 }}
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            const action = actionForShortcut(e.key);
            if (!action) return;
            e.preventDefault();
            run(action);
          }}
        />
      )}

      <p style={counter(overLimit)}>
        {/* Only once it is worth knowing: a counter on a 12-character description
            is noise, while the cap is a 400 waiting to happen. */}
        {overLimit
          ? `${value.length} characters — ${MAX_DESCRIPTION} is the limit.`
          : value.length > MAX_DESCRIPTION * 0.8
            ? `${value.length} / ${MAX_DESCRIPTION}`
            : "Markdown: **bold**, _italic_, [links](https://), lists."}
      </p>
    </div>
  );
}

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: theme.space(2),
  marginBottom: theme.space(1),
};

const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
};

/** A worded button ("Link") needs its own width; the glyph buttons stay square. */
const wordButton: CSSProperties = { width: "auto", padding: "0 8px" };

const toolButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 24,
  height: 24,
  padding: 0,
  border: "none",
  borderRadius: theme.radius.sm,
  background: "transparent",
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 12,
  cursor: "pointer",
};

/** Same box as the textarea it replaces, so toggling does not move the footer. */
const previewBox: CSSProperties = {
  minHeight: 120,
  maxHeight: 240,
  overflowY: "auto",
  padding: "8px 12px",
  border: `1px solid ${theme.color.controlBorder}`,
  borderRadius: theme.radius.md,
  background: theme.color.surface,
  color: theme.color.text,
  fontFamily: theme.font.ui,
  fontSize: 13,
};

const counter = (over: boolean): CSSProperties => ({
  margin: `${theme.space(1)} 0 0`,
  fontFamily: theme.font.ui,
  fontSize: 11,
  color: over ? theme.color.danger : theme.color.textMuted,
});
