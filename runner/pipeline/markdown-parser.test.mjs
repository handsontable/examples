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
  // The `---` joins the paragraph — thematic breaks have never been a block
  // here. What matters is that it does not turn the line above into a table.
  const blocks = parseMarkdown("Options: `stretchH: 'all' | 'last'`\n---\n### Next section");
  assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "heading"]);
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

test("table inside a fenced code block stays literal", () => {
  const blocks = parseMarkdown("```\n| A |\n|---|\n```");
  assert.deepEqual(blocks.map((b) => b.kind), ["code"]);
});

test("list still parses and terminates at a table", () => {
  const blocks = parseMarkdown("- one\n- two\n| A | B |\n|---|---|\n| 1 | 2 |");
  assert.deepEqual(blocks.map((b) => b.kind), ["list", "table"]);
});
