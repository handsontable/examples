// The description editor's toolbar, as pure text transforms (DEV-2507).
//
// Each action takes the field's current value and selection and returns the next
// value and selection. No DOM, no React — so `pipeline/markdown-actions.test.mjs`
// can drive every case, including the ones nobody clicks through by hand: an empty
// caret, a selection that already carries the syntax, a multi-line selection.
//
// The stored format stays markdown text (a D1 `TEXT` column, rendered in three
// places). These actions are what makes it unnecessary to *type* markdown; they
// are not a rich-text model, and the field is not contenteditable — see the ticket
// for why that is a separate, much larger change.

/** A text field's state: what is in it, and what is selected. */
export interface FieldState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export type MarkdownAction =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "bulletList"
  | "numberedList"
  | "heading";

/** Inline actions wrap the selection in a marker; block actions prefix lines. */
const WRAPPERS: Record<"bold" | "italic" | "code", string> = {
  bold: "**",
  italic: "_",
  code: "`",
};

/** Placeholder text inserted when an action fires on an empty selection, so the
 *  result is something to type over rather than bare syntax. */
const PLACEHOLDER: Record<MarkdownAction, string> = {
  bold: "bold text",
  italic: "italic text",
  code: "code",
  link: "link text",
  bulletList: "item",
  numberedList: "item",
  heading: "Heading",
};

function selected(state: FieldState): string {
  return state.value.slice(state.selectionStart, state.selectionEnd);
}

function splice(state: FieldState, replacement: string, select: [number, number]): FieldState {
  return {
    value: state.value.slice(0, state.selectionStart) + replacement + state.value.slice(state.selectionEnd),
    selectionStart: select[0],
    selectionEnd: select[1],
  };
}

/** `**text**` -> `text`, when the action would otherwise double the markers. */
function unwrap(state: FieldState, marker: string): FieldState | null {
  const text = selected(state);
  if (text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)) {
    const inner = text.slice(marker.length, text.length - marker.length);
    return splice(state, inner, [state.selectionStart, state.selectionStart + inner.length]);
  }
  // Also handle the markers sitting *outside* the selection, which is what a
  // user gets by double-clicking the word inside `**bold**`.
  const before = state.value.slice(state.selectionStart - marker.length, state.selectionStart);
  const after = state.value.slice(state.selectionEnd, state.selectionEnd + marker.length);
  if (before === marker && after === marker) {
    return {
      value:
        state.value.slice(0, state.selectionStart - marker.length) +
        text +
        state.value.slice(state.selectionEnd + marker.length),
      selectionStart: state.selectionStart - marker.length,
      selectionEnd: state.selectionEnd - marker.length,
    };
  }
  return null;
}

function wrapInline(state: FieldState, marker: string, placeholder: string): FieldState {
  const toggled = unwrap(state, marker);
  if (toggled) return toggled;
  const text = selected(state) || placeholder;
  const start = state.selectionStart + marker.length;
  return splice(state, `${marker}${text}${marker}`, [start, start + text.length]);
}

/** The line boundaries the selection touches — block actions work on whole lines. */
function lineRange(value: string, from: number, to: number): [number, number] {
  const start = value.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const nextBreak = value.indexOf("\n", to);
  return [start, nextBreak === -1 ? value.length : nextBreak];
}

/**
 * Prefix every selected line, or strip the prefix when every line already has it
 * (so the same button turns a list off).
 *
 * `prefixFor` takes the line's index within the selection, which is what makes an
 * ordered list count.
 */
function prefixLines(
  state: FieldState,
  prefixFor: (index: number) => string,
  matcher: RegExp,
  placeholder: string,
): FieldState {
  const [from, to] = lineRange(state.value, state.selectionStart, state.selectionEnd);
  const block = state.value.slice(from, to) || placeholder;
  const lines = block.split("\n");
  const allPrefixed = lines.every((line) => matcher.test(line));
  const next = lines
    .map((line, index) => (allPrefixed ? line.replace(matcher, "") : `${prefixFor(index)}${line}`))
    .join("\n");
  return {
    value: state.value.slice(0, from) + next + state.value.slice(to),
    selectionStart: from,
    selectionEnd: from + next.length,
  };
}

/**
 * Apply one toolbar action.
 *
 * `link` produces `[text](url)` and leaves the selection on `url`, because the
 * text is the part the user already has and the URL is the part they must type.
 */
export function applyMarkdownAction(action: MarkdownAction, state: FieldState): FieldState {
  switch (action) {
    case "bold":
    case "italic":
    case "code":
      return wrapInline(state, WRAPPERS[action], PLACEHOLDER[action]);
    case "link": {
      const text = selected(state) || PLACEHOLDER.link;
      const url = "https://";
      const urlStart = state.selectionStart + `[${text}](`.length;
      return splice(state, `[${text}](${url})`, [urlStart, urlStart + url.length]);
    }
    case "bulletList":
      return prefixLines(state, () => "- ", /^- /, PLACEHOLDER.bulletList);
    case "numberedList":
      return prefixLines(state, (index) => `${index + 1}. `, /^\d+\. /, PLACEHOLDER.numberedList);
    case "heading":
      // One level only. A description is a paragraph or two with the odd label in
      // it; offering h1–h6 in a 320px sidebar would be a menu nobody needs.
      return prefixLines(state, () => "## ", /^#{1,6} /, PLACEHOLDER.heading);
  }
}

/** Cmd/Ctrl shortcuts, so a toolbar-only editor does not feel broken to a typist. */
export function actionForShortcut(key: string): MarkdownAction | null {
  switch (key.toLowerCase()) {
    case "b":
      return "bold";
    case "i":
      return "italic";
    default:
      return null;
  }
}
