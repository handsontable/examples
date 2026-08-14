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
      case "image":
        return (
          // Clickable, because a 1,400px screenshot of the app inside a 700px reading
          // measure is legible as a shape and not as text. The browser's own image
          // view is the zoom — no lightbox to build, and middle-click and "save as"
          // keep working like any other image.
          //
          // `loading="lazy"` is the whole reason the guide can carry figures at all:
          // the track you are not reading costs nothing, and the screencast is
          // megabytes. The caption is the prose underneath, not something drawn here.
          <a
            key={key}
            href={node.src}
            target="_blank"
            rel="noreferrer"
            style={{ display: "block" }}
            title="Open the full-size image"
          >
            <img
              src={node.src}
              alt={node.alt}
              loading="lazy"
              decoding="async"
              style={imageStyle}
            />
          </a>
        );
      case "link": {
        // A link to another page of this app stays in the tab: the guide's tracks
        // cross-reference each other (DEV-2522), and a new tab per cross-reference
        // turns reading two tracks into a window-management problem. Everything
        // else — model answers, documentation links — still leaves.
        const internal = node.href.startsWith("/") && !node.href.startsWith("//");
        return (
          <a
            key={key}
            href={node.href}
            target={internal ? undefined : "_blank"}
            rel={internal ? undefined : "noreferrer"}
            style={linkStyle}
          >
            {node.text}
          </a>
        );
      }
      default:
        return node.text;
    }
  });
}

/**
 * `document` renders headings at their real level and as real `h1`–`h6` elements.
 *
 * The default is the chat panel this renderer was built for: a 400px drawer where
 * every heading is one 13px weight-600 line, because a document scale inside a
 * side panel is noise. A page of prose (`/guide`, DEV-2503) needs the opposite —
 * without hierarchy the title, the section headings and the body all read as the
 * same thing — and it needs the landmarks a screen reader navigates by.
 *
 * `headingIds` gives the headings anchor ids, by document order — the nth entry is
 * the nth heading. The ids are computed by the caller (`guideTracks.ts`) rather than
 * here so that the page's contents list and the rendered anchors come from one
 * function; a slugger inside this file would be a second implementation of the same
 * rule, free to disagree with the first.
 */
export function Markdown({
  text,
  error,
  document: asDocument,
  headingIds,
}: {
  text: string;
  error?: boolean;
  document?: boolean;
  headingIds?: readonly (string | undefined)[];
}) {
  const blocks = parseMarkdown(text);
  // Counted during the map, not stored: render order is document order, so the nth
  // heading rendered is the nth heading parsed on every render.
  let headingIndex = -1;
  return (
    <div style={{ color: error ? theme.color.danger : undefined }}>
      {blocks.map((block, i) => {
        const key = String(i);
        switch (block.kind) {
          case "code":
            return <pre key={key} style={preStyle}><code>{block.text}</code></pre>;
          case "rule":
            return <hr key={key} style={ruleStyle} />;
          case "heading": {
            headingIndex += 1;
            if (!asDocument) {
              return (
                <div key={key} style={headingStyle}>
                  {renderInline(block.children, key)}
                </div>
              );
            }
            // `h1`–`h6`, clamped: the parser reports the `#` count, and a stray
            // `#######` must not become an invalid tag name.
            const level = Math.min(Math.max(block.level, 1), 6);
            const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <Tag
                key={key}
                id={headingIds?.[headingIndex]}
                // Cleared by the anchor scroll otherwise: the page's own header is
                // sticky, so a heading scrolled to by `#id` would sit under it.
                style={{ ...documentHeadingStyle(level), scrollMarginTop: 16 }}
              >
                {renderInline(block.children, key)}
              </Tag>
            );
          }
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
/** Full-width inside the measure, with a frame so a screenshot of the app does not
 *  bleed into the page around it.
 *
 *  `controlBorder`, not `border`: dark `border` is #222222, which is the value of dark
 *  `surfaceRaised` — the drawer and dialog fill this renderer also paints inside, where
 *  a `border` frame would be invisible. */
const imageStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "auto",
  margin: "10px 0 4px",
  border: `1px solid ${theme.color.controlBorder}`,
  borderRadius: theme.radius.sm,
  background: theme.color.surfaceSunken,
  cursor: "zoom-in",
};

const codeStyle: React.CSSProperties = {
  fontFamily: theme.font.mono, fontSize: "0.92em", background: theme.color.surfaceMuted,
  border: `1px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.sm,
  padding: `0 ${theme.space(1)}`,
};
const preStyle: React.CSSProperties = {
  background: theme.color.editorBg, color: theme.color.text, borderRadius: theme.radius.md,
  padding: 10, overflowX: "auto", fontFamily: theme.font.mono, fontSize: 12, margin: "0 0 8px",
};
// A section divider, not a box edge: one hairline, no default 3D border, and
// `controlBorder` rather than `border` — dark's `border` is `surfaceRaised`, the
// drawer's own fill, so the rule would be invisible exactly where it is needed.
const ruleStyle: React.CSSProperties = {
  border: 0, borderTop: `1px solid ${theme.color.controlBorder}`, margin: "12px 0",
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

/** Document headings (`document` mode). Sizes step down and the space above each
 *  one is what actually separates sections — a heading that hugs the paragraph
 *  before it reads as part of it. */
function documentHeadingStyle(level: number): React.CSSProperties {
  const size = level === 1 ? 24 : level === 2 ? 18 : level === 3 ? 15 : 14;
  return {
    fontSize: size,
    fontWeight: level === 1 ? 700 : 600,
    lineHeight: 1.3,
    // No top margin on the title: it is the first thing on the page.
    margin: level === 1
      ? `0 0 ${theme.space(4)}`
      : `${theme.space(level === 2 ? 7 : 5)} 0 ${theme.space(2)}`,
  };
}
const listStyle: React.CSSProperties = { margin: "0 0 8px", paddingLeft: 20 };
