// Markdown parsing for assistant answers (DEV-2047).
//
// Pure — no React, no DOM — so the grammar can be reasoned about and tested on
// its own. `markdown.tsx` turns these nodes into elements.
//
// The first version of this parser split the text on blank lines and required
// each chunk to be entirely one thing: all heading, or all list, or all prose.
// Models do not write that way. They write
//
//     ### Features demonstrated
//     - **Dropdown menus** (`dropdownMenu: true`) — per-column header menus
//     - **Filters** (`filters: true`) — filter rows by column values
//
// with no blank line anywhere, and the whole chunk fell through to "paragraph"
// — which is why headings rendered as literal `###` and bullets as literal
// `-`. Markdown is a LINE grammar: this parser walks lines and groups runs of
// the same kind, which is what the format actually is.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] };

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "code"; text: string };

const BULLET = /^\s*[-*+]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
/** A wrapped continuation of the previous list item, not a new one. */
const INDENTED = /^\s{2,}\S/;
/** `|---|:--:|` — the row that makes the line above it a table header. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const isBullet = (l: string) => BULLET.test(l);
const isOrdered = (l: string) => ORDERED.test(l);
const isHeading = (l: string) => HEADING.test(l);

/**
 * A table starts only where a pipe line is followed by a delimiter row with the
 * same number of cells. Both halves matter: without the lookahead, prose like
 * "use `a | b`" becomes a one-row table; without the cell count, that same
 * prose followed by a `---` section break does — `---` is a valid one-cell
 * delimiter, and models emit those separators constantly.
 */
const isTableStart = (lines: string[], i: number) => {
  const header = lines[i] ?? "";
  const delimiter = lines[i + 1] ?? "";
  if (!header.includes("|") || !TABLE_DELIMITER.test(delimiter)) return false;
  return splitRow(delimiter).length === splitRow(header).length;
};

const startsBlock = (lines: string[], i: number) => {
  const line = lines[i] ?? "";
  return isHeading(line) || isBullet(line) || isOrdered(line) || isTableStart(lines, i);
};

/**
 * `| a | b |` → `["a", "b"]`. One outer pipe on each side is optional, and a
 * `\|` is a literal pipe inside a cell — the only way to write a union like
 * `'left' \| 'center'`, which is exactly what a config table is full of.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "");
  // A trailing `\|` is content, not the closing pipe.
  const body = trimmed.endsWith("|") && !trimmed.endsWith("\\|") ? trimmed.slice(0, -1) : trimmed;
  const cells: string[] = [""];
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char === "\\" && body[i + 1] === "|") {
      cells[cells.length - 1] += "|";
      i++;
    } else if (char === "|") {
      cells.push("");
    } else {
      cells[cells.length - 1] += char;
    }
  }
  return cells.map((cell) => cell.trim());
}

/** Only absolute http(s) links survive; `javascript:` and friends stay text. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const INLINE_TOKEN = /(`[^`]+`)|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/;

/**
 * Inline spans, applied recursively.
 *
 * Nesting is the point: models write **`fixedColumnsStart`** constantly, and a
 * non-recursive pass renders that as bold text containing literal backticks.
 * Code is the one terminal case — everything inside a code span is literal,
 * which is what makes it code.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;

  while (rest.length > 0) {
    const match = INLINE_TOKEN.exec(rest);
    if (!match || match.index === undefined) break;

    if (match.index > 0) out.push({ kind: "text", text: rest.slice(0, match.index) });
    const token = match[0];

    if (token.startsWith("`")) {
      out.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      out.push({ kind: "strong", children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const href = safeHref(token.slice(split + 2, -1));
      const label = token.slice(1, split);
      out.push(href ? { kind: "link", text: label, href } : { kind: "text", text: label });
    } else {
      out.push({ kind: "em", children: parseInline(token.slice(1, -1)) });
    }
    rest = rest.slice(match.index + token.length);
  }

  if (rest.length > 0) out.push({ kind: "text", text: rest });
  return out;
}

/** Walk the lines, grouping runs of the same kind. */
function parseLines(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) { i++; continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      i += 2; // header + delimiter
      const rows: Inline[][][] = [];
      // A pipe alone does not make a row: a bullet, heading or new table that
      // happens to contain one ends the body, exactly as it would end a
      // paragraph. Without this the block after the table gets eaten as rows.
      while (
        i < lines.length
        && (lines[i] ?? "").includes("|")
        && (lines[i] ?? "").trim()
        && !startsBlock(lines, i)
      ) {
        const cells = splitRow(lines[i] ?? "");
        // Ragged rows render as a broken grid, so square them off against the header.
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length).map(parseInline));
        i++;
      }
      blocks.push({ kind: "table", header: header.map(parseInline), rows });
      continue;
    }

    if (isBullet(line) || isOrdered(line)) {
      const ordered = isOrdered(line);
      const items: string[] = [];
      // A run ends at the first line that is neither another item of the same
      // kind nor an indented continuation of the current one.
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const matchesKind = ordered ? isOrdered(current) : isBullet(current);
        if (matchesKind) {
          items.push(current.replace(ordered ? ORDERED : BULLET, ""));
          i++;
        } else if (items.length > 0 && current.trim() && INDENTED.test(current) && !startsBlock(lines, i)) {
          items[items.length - 1] += ` ${current.trim()}`;
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered, items: items.map(parseInline) });
      continue;
    }

    // Everything up to the next blank line or block starter is one paragraph.
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !startsBlock(lines, i)) {
      paragraph.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

/**
 * Parse an answer. Fenced code is taken out first: everything inside a fence
 * is literal, including the characters that would otherwise be markup.
 */
export function parseMarkdown(text: string): Block[] {
  const parts = text.split(/```(?:[a-zA-Z0-9+#.-]*)\n?/);
  const blocks: Block[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push({ kind: "code", text: part.replace(/\n$/, "") });
    } else {
      blocks.push(...parseLines(part));
    }
  });
  return blocks;
}
