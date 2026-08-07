// Rendering for parsed assistant answers (DEV-2047). The grammar lives in
// markdownParser.ts; this file only turns nodes into elements. (Separate names,
// not markdown.ts/.tsx — a "./markdown.js" import would be ambiguous between
// the two, and could resolve to this file importing itself.)
//
// Deliberately not a Markdown library: this builds React elements and never
// touches `innerHTML`, so model output cannot inject markup no matter what it
// contains. A library would add a dependency to the authoring bundle and, in
// most cases, an HTML sink to sanitise.

import type { ReactNode } from "react";
import { theme } from "@handsontable/demo-editor-shell";
import { parseMarkdown, type Inline } from "./markdownParser.js";

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.kind) {
      case "code":
        return <code key={key} style={codeStyle}>{node.text}</code>;
      case "strong":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "link":
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer" style={linkStyle}>
            {node.text}
          </a>
        );
      default:
        return node.text;
    }
  });
}

export function Markdown({ text, error }: { text: string; error?: boolean }) {
  const blocks = parseMarkdown(text);
  return (
    <div style={{ color: error ? theme.color.danger : undefined }}>
      {blocks.map((block, i) => {
        const key = String(i);
        switch (block.kind) {
          case "code":
            return <pre key={key} style={preStyle}><code>{block.text}</code></pre>;
          case "heading":
            return (
              <div key={key} style={{ ...headingStyle, fontSize: Math.max(12.5, 16 - block.level) }}>
                {renderInline(block.children, key)}
              </div>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={key} style={listStyle}>
                {block.items.map((item, j) => (
                  <li key={j} style={{ margin: "3px 0" }}>{renderInline(item, `${key}-${j}`)}</li>
                ))}
              </List>
            );
          }
          default:
            return (
              <p key={key} style={{ margin: "0 0 8px", whiteSpace: "pre-wrap" }}>
                {renderInline(block.children, key)}
              </p>
            );
        }
      })}
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
const headingStyle: React.CSSProperties = { fontWeight: 600, margin: "12px 0 4px" };
const listStyle: React.CSSProperties = { margin: "0 0 8px", paddingLeft: 20 };
