// A small Markdown renderer for assistant answers (DEV-2047).
//
// Models write Markdown whether you ask them to or not — bold, bullet lists,
// inline `code`, the occasional heading — so an answer rendered as plain text
// shows its asterisks and reads like a mangled email.
//
// This is deliberately not a Markdown library. It renders React elements
// directly and never touches `innerHTML`, so untrusted model output cannot
// inject markup no matter what it contains; a library would add a dependency
// to the authoring bundle and, in most cases, an HTML sink to sanitise. The
// supported subset is what answers actually use:
//
//   ```fenced code```   #/##/### headings   - and 1. lists
//   **bold**   *italic*/_italic_   `inline code`   [links](https://…)
//
// Anything else falls through as text, which is the correct failure: an
// unrendered character is a blemish, a broken renderer is a broken answer.

import type { ReactNode } from "react";
import { theme } from "@handsontable/demo-editor-shell";

/** Only absolute http(s) links are rendered as links. Anything else — a
 *  `javascript:` URL above all — stays inert text. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/g;

/** Bold / italic / code / links inside a line of prose. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;

  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    if (token.startsWith("`")) {
      out.push(<code key={key} style={codeStyle}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      out.push(href
        ? <a key={key} href={href} target="_blank" rel="noreferrer" style={linkStyle}>{label}</a>
        : label);
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One prose block: heading, list, or paragraph. */
function block(text: string, key: string): ReactNode {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0] ?? "");
  if (heading && lines.length === 1) {
    return (
      <div key={key} style={{ ...headingStyle, fontSize: 15 - heading[1]!.length }}>
        {inline(heading[2] ?? "", key)}
      </div>
    );
  }

  const bulleted = lines.every((l) => /^\s*[-*]\s+/.test(l));
  const numbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
  if (bulleted || numbered) {
    const items = lines.map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""));
    const List = numbered ? "ol" : "ul";
    return (
      <List key={key} style={listStyle}>
        {items.map((item, i) => <li key={i} style={{ margin: "2px 0" }}>{inline(item, `${key}-${i}`)}</li>)}
      </List>
    );
  }

  return (
    <p key={key} style={{ margin: "0 0 8px", whiteSpace: "pre-wrap" }}>
      {inline(text.trim(), key)}
    </p>
  );
}

export function Markdown({ text, error }: { text: string; error?: boolean }) {
  // Fenced code first: everything inside a fence is literal, including the
  // characters that would otherwise be markup.
  const parts = text.split(/```(?:[a-zA-Z0-9+-]*)\n?/);
  return (
    <div style={{ color: error ? theme.color.danger : undefined }}>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <pre key={i} style={preStyle}><code>{part.replace(/\n$/, "")}</code></pre>
          : part.split(/\n{2,}/).map((chunk, j) => block(chunk, `${i}-${j}`)),
      )}
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: "0.92em", background: theme.color.surfaceMuted,
  border: `1px solid ${theme.color.border}`, borderRadius: 4, padding: "0 4px",
};
const preStyle: React.CSSProperties = {
  background: theme.color.editorBg, color: theme.color.editorText, borderRadius: theme.radius.md,
  padding: 10, overflowX: "auto", fontFamily: theme.font.mono, fontSize: 11.5, margin: "0 0 8px",
};
const linkStyle: React.CSSProperties = { color: theme.color.accent };
const headingStyle: React.CSSProperties = { fontWeight: 600, margin: "10px 0 6px" };
const listStyle: React.CSSProperties = { margin: "0 0 8px", paddingLeft: 20 };
