// Grammar of the assistant-answer parser (apps/authoring/src/markdownParser.ts).
// The source is type-annotations-only, so `node --experimental-strip-types`
// imports it directly — the authoring app has no build output to test against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "../apps/authoring/src/markdownParser.ts";

/** Flatten a run of inline nodes back to its visible text. */
const text = (nodes) =>
  nodes.map((n) => ("children" in n ? text(n.children) : (n.text ?? ""))).join("");

test("pipe table after a heading", () => {
  const blocks = parseMarkdown("### Features Enabled\n| Feature | Config |\n|---|---|\n| Filters | `filters={true}` |\n| Sorting | `multiColumnSorting` |");
  assert.equal(blocks.length, 2);
  const t = blocks[1];
  assert.equal(t.kind, "table");
  assert.deepEqual(t.header.map(text), ["Feature", "Config"]);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0].map(text), ["Filters", "filters={true}"]);
  assert.equal(t.rows[0][1][0].kind, "code");
});

test("table straight after prose with no blank line", () => {
  const blocks = parseMarkdown("Here is what it does:\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "table"]);
});

test("prose containing a pipe is not a table", () => {
  const blocks = parseMarkdown("Use `a | b` for either value.\nSecond line.");
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph"]);
});

test("ragged rows squared off against header", () => {
  const [t] = parseMarkdown("| A | B | C |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |");
  assert.deepEqual(t.rows.map((r) => r.length), [3, 3]);
});

test("aligned delimiter and no outer pipes", () => {
  const [t] = parseMarkdown("A | B\n:--- | ---:\n1 | 2");
  assert.equal(t.kind, "table");
  assert.deepEqual(t.header.map(text), ["A", "B"]);
});

test("a pipe line above a `---` section break is not a table", () => {
  // The `---` is its own rule since DEV-2197; what this guards is unchanged —
  // it must not turn the prose above it into a one-cell table.
  const blocks = parseMarkdown("Options: `stretchH: 'all' | 'last'`\n---\n### Next section");
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "rule", "heading"]);
  assert.equal(text(blocks[0].children), "Options: stretchH: 'all' | 'last'");
});

test("delimiter cell count must match the header", () => {
  const blocks = parseMarkdown("| A | B | C |\n|---|---|\n| 1 | 2 | 3 |");
  assert.equal(blocks.every((b) => b.kind !== "table"), true);
});

test("escaped pipes stay inside their cell", () => {
  const [t] = parseMarkdown("| Option | Values |\n|---|---|\n| align | `'left' \\| 'center'` |");
  assert.deepEqual(t.rows[0].map(text), ["align", "'left' | 'center'"]);
  assert.equal(t.rows[0].length, 2);
});

test("a block starter containing a pipe ends the table body", () => {
  const blocks = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n- use `a | b` here\n### Next | section");
  assert.deepEqual(blocks.map((b) => b.kind), ["table", "list", "heading"]);
  assert.equal(blocks[0].rows.length, 1);
});

test("a second table right after the first opens its own block", () => {
  const blocks = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n| C | D |\n|---|---|\n| 3 | 4 |");
  assert.deepEqual(blocks.map((b) => b.kind), ["table", "table"]);
  assert.deepEqual(blocks[1].header.map(text), ["C", "D"]);
});

test("table inside a fenced code block stays literal", () => {
  const blocks = parseMarkdown("```\n| A |\n|---|\n```");
  assert.deepEqual(blocks.map((b) => b.kind), ["code"]);
});

test("list still parses and terminates at a table", () => {
  const blocks = parseMarkdown("- one\n- two\n| A | B |\n|---|---|\n| 1 | 2 |");
  assert.deepEqual(blocks.map((b) => b.kind), ["list", "table"]);
});

// `---` between sections is the divider models reach for constantly, and it was
// falling through to a paragraph and rendering as literal dashes (DEV-2197,
// spotted in a blog screenshot of the panel).
test("a --- between sections is a rule, not literal text", () => {
  const blocks = parseMarkdown("Data & Layout\n\n---\n\nColumns & Headers");
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "rule", "paragraph"]);
});

test("a rule ends the paragraph above it without a blank line", () => {
  const blocks = parseMarkdown("Here is the breakdown:\n---\nNext section");
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "rule", "paragraph"]);
  assert.equal(text(blocks[0].children), "Here is the breakdown:");
});

test("*** and ___ are rules too", () => {
  assert.deepEqual(parseMarkdown("a\n\n***\n\nb").map((b) => b.kind), ["paragraph", "rule", "paragraph"]);
  assert.deepEqual(parseMarkdown("a\n\n___\n\nb").map((b) => b.kind), ["paragraph", "rule", "paragraph"]);
});

test("a table's delimiter row is never mistaken for a rule", () => {
  // The delimiter is consumed with the header, so the rule check never sees it.
  // Single-column tables are the case that would break if it did.
  const blocks = parseMarkdown("| Option |\n| --- |\n| data |");
  assert.deepEqual(blocks.map((b) => b.kind), ["table"]);
  const wide = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
  assert.deepEqual(wide.map((b) => b.kind), ["table"]);
});

test("dashes inside a fenced code block stay code", () => {
  const blocks = parseMarkdown("```\n---\n```");
  assert.deepEqual(blocks.map((b) => b.kind), ["code"]);
  assert.equal(blocks[0].text, "---");
});

test("a bullet is still a bullet, not a rule", () => {
  assert.deepEqual(parseMarkdown("- one\n- two").map((b) => b.kind), ["list"]);
  // Two dashes is not enough for a rule, and there is no space, so it is prose.
  assert.deepEqual(parseMarkdown("a -- b").map((b) => b.kind), ["paragraph"]);
});

// Link safety (DEV-2522). `safeHref` gained a same-origin path form so the guide's
// tracks can link to each other; the renderer draws model output and user-written
// demo descriptions through the same function, so what it *rejects* is the part
// worth pinning.
test("root-relative links survive, and only genuine paths do", () => {
  const link = (md) => {
    const blocks = parseMarkdown(md);
    const nodes = blocks[0].children;
    return nodes.find((n) => n.kind === "link") ?? null;
  };

  assert.equal(link("see [the Developers track](/guide/developers) for that")?.href, "/guide/developers");
  assert.equal(link("[a section](/guide/support#7-title-and-description)")?.href, "/guide/support#7-title-and-description");
  assert.equal(link("[with a query](/all-demos?owner=someone)")?.href, "/all-demos?owner=someone");

  // Protocol-relative in disguise: `//host` is an origin, and the URL spec treats
  // `/\` the same way — both would leave the site while looking like a path.
  assert.equal(link("[nope](//evil.example)"), null);
  assert.equal(link("[nope](/\\evil.example)"), null);
  // Still no scheme smuggling, and still no bare relative paths (which would
  // resolve against whatever page the renderer happens to be on).
  assert.equal(link("[nope](javascript:alert(1))"), null);
  assert.equal(link("[nope](data:text/html,<script>)"), null);
  assert.equal(link("[nope](guide/support)"), null);
  // The absolute form is untouched.
  assert.equal(link("[docs](https://handsontable.com/docs)")?.href, "https://handsontable.com/docs");
});
