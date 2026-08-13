// The description editor's toolbar actions (DEV-2507).
//
// Pure text transforms, so every case that is tedious to click through lives here
// instead: an empty caret, a selection that already has the syntax, markers just
// outside the selection, a multi-line block, an ordered list that has to count.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  actionForShortcut,
  applyMarkdownAction,
} from "../apps/authoring/src/markdownActions.ts";

/** `"a[bc]d"` -> the field state with `bc` selected. Keeps the cases readable. */
function field(marked) {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), selectionStart: start, selectionEnd: end };
}

/** The inverse, so an assertion shows what is selected after the action. */
function show(state) {
  return (
    state.value.slice(0, state.selectionStart) +
    "[" +
    state.value.slice(state.selectionStart, state.selectionEnd) +
    "]" +
    state.value.slice(state.selectionEnd)
  );
}

test("bold wraps the selection and keeps it selected", () => {
  assert.equal(show(applyMarkdownAction("bold", field("make [this] bold"))), "make **[this]** bold");
});

test("bold on an empty caret inserts something to type over", () => {
  const state = applyMarkdownAction("bold", { value: "", selectionStart: 0, selectionEnd: 0 });
  assert.equal(show(state), "**[bold text]**");
});

test("bold twice returns the original text", () => {
  const once = applyMarkdownAction("bold", field("make [this] bold"));
  const twice = applyMarkdownAction("bold", once);
  assert.equal(show(twice), "make [this] bold");
});

test("bold un-bolds when the markers sit outside the selection", () => {
  // What a double-click on the word inside `**bold**` actually produces.
  assert.equal(show(applyMarkdownAction("bold", field("a **[word]** b"))), "a [word] b");
});

test("italic and code use their own markers", () => {
  assert.equal(show(applyMarkdownAction("italic", field("[x]"))), "_[x]_");
  assert.equal(show(applyMarkdownAction("code", field("[x]"))), "`[x]`");
  // …and each toggles independently of the others.
  assert.equal(show(applyMarkdownAction("italic", field("_[x]_"))), "[x]");
});

test("link keeps the text and selects the URL, which is what needs typing", () => {
  const state = applyMarkdownAction("link", field("see [the docs] here"));
  assert.equal(state.value, "see [the docs](https://) here");
  assert.equal(state.value.slice(state.selectionStart, state.selectionEnd), "https://");
});

test("link on an empty caret gives both halves", () => {
  const state = applyMarkdownAction("link", { value: "", selectionStart: 0, selectionEnd: 0 });
  assert.equal(state.value, "[link text](https://)");
  assert.equal(state.value.slice(state.selectionStart, state.selectionEnd), "https://");
});

test("a bullet list prefixes every line the selection touches", () => {
  const state = field("[one\ntwo\nthree]");
  assert.equal(applyMarkdownAction("bulletList", state).value, "- one\n- two\n- three");
});

test("a bullet list toggles off when every line already has it", () => {
  const state = field("[- one\n- two]");
  assert.equal(applyMarkdownAction("bulletList", state).value, "one\ntwo");
});

test("a numbered list counts", () => {
  const state = field("[one\ntwo\nthree]");
  assert.equal(applyMarkdownAction("numberedList", state).value, "1. one\n2. two\n3. three");
  // …and toggles back off whatever the numbers were.
  assert.equal(applyMarkdownAction("numberedList", field("[1. one\n2. two]")).value, "one\ntwo");
});

test("a block action works from a caret inside a line, not just a selection", () => {
  // Caret in the middle of "two": the whole line is the unit.
  const state = { value: "one\ntwo\nthree", selectionStart: 5, selectionEnd: 5 };
  assert.equal(applyMarkdownAction("bulletList", state).value, "one\n- two\nthree");
});

test("heading prefixes with ## and strips any existing level", () => {
  assert.equal(applyMarkdownAction("heading", field("[Title]")).value, "## Title");
  assert.equal(applyMarkdownAction("heading", field("[#### Title]")).value, "Title");
});

test("Cmd/Ctrl+B and +I map to their actions, and nothing else does", () => {
  assert.equal(actionForShortcut("b"), "bold");
  assert.equal(actionForShortcut("B"), "bold");
  assert.equal(actionForShortcut("i"), "italic");
  for (const key of ["k", "u", "Enter", "1"]) assert.equal(actionForShortcut(key), null, key);
});

test("no action loses text outside the selection", () => {
  const before = "keep this\n\n[change me]\n\nand this";
  for (const action of ["bold", "italic", "code", "link", "bulletList", "numberedList", "heading"]) {
    const state = applyMarkdownAction(action, field(before));
    assert.match(state.value, /^keep this\n\n/, action);
    assert.match(state.value, /\n\nand this$/, action);
  }
});
