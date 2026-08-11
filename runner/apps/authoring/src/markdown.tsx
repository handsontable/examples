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
              <div key={key} style={headingStyle}>
                {renderInline(block.children, key)}
              </div>
            );
          case "table":
            return (
              <div key={key} style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      {block.header.map((cell, j) => (
                        <th key={j} style={thStyle}>{renderInline(cell, `${key}-h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k} style={tdStyle}>{renderInline(cell, `${key}-${j}-${k}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
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

// `controlBorder`, for the same reason the table below gives: the chat drawer is
// `surfaceRaised`, which dark `border` *is*, so this outline would vanish there.
const codeStyle: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: "0.92em", background: theme.color.surfaceMuted,
  border: `1px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.sm,
  padding: `0 ${theme.space(1)}`,
};
const preStyle: React.CSSProperties = {
  background: theme.color.editorBg, color: theme.color.text, borderRadius: theme.radius.md,
  padding: 10, overflowX: "auto", fontFamily: theme.font.mono, fontSize: 12, margin: "0 0 8px",
};
// The chat panel is ~380px, so a table is expected to overflow: scroll it in
// its own box rather than widening the column. `controlBorder`, not `border` —
// dark's `border` is `surfaceRaised`, so cell rules would disappear there.
const tableWrapStyle: React.CSSProperties = { overflowX: "auto", margin: "0 0 8px", maxWidth: "100%" };
const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse", fontSize: 12, width: "100%",
  border: `1px solid ${theme.color.controlBorder}`,
};
const cellStyle: React.CSSProperties = {
  border: `1px solid ${theme.color.controlBorder}`, padding: "4px 8px",
  textAlign: "left", verticalAlign: "top",
};
const thStyle: React.CSSProperties = {
  ...cellStyle, fontWeight: 600, background: theme.color.surfaceMuted, whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = cellStyle;
const linkStyle: React.CSSProperties = { color: theme.color.accentText };
/** Every heading level at the body size, weight carrying the hierarchy. The
 *  levels used to be sized 15.5 / 14.5 / 13.5 / 12.5 — four steps, none of them on
 *  the shell's scale, inside a 400px drawer where two of them are a fraction of a
 *  pixel apart on screen anyway (DEV-2209). */
const headingStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 600, margin: `${theme.space(3)} 0 ${theme.space(1)}`,
};
const listStyle: React.CSSProperties = { margin: "0 0 8px", paddingLeft: 20 };
