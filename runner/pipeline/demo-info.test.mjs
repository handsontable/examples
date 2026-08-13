// Title and description validation for a demo (DEV-2507).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DESCRIPTION,
  MAX_TITLE,
  isValidationError,
  validateDescription,
  validateTitle,
} from "../workers/api/src/demo-info.ts";

test("a title is required, trimmed, and bounded", () => {
  assert.equal(validateTitle("  Sales grid  "), "Sales grid");
  for (const raw of ["", "   ", null, undefined, 42]) {
    assert.ok(isValidationError(validateTitle(raw)), JSON.stringify(raw));
  }
  assert.ok(isValidationError(validateTitle("x".repeat(MAX_TITLE + 1))));
  assert.equal(validateTitle("x".repeat(MAX_TITLE)).length, MAX_TITLE);
});

test("a description keeps its paragraphs", () => {
  // The reason the field exists: two paragraphs, a list, and the blank lines that
  // make markdown out of them. Anything that collapsed whitespace here would turn
  // the whole description into one run-on paragraph.
  const text = "First paragraph.\n\nSecond one, with:\n\n- a bullet\n- another\n\nAnd a close.";
  assert.equal(validateDescription(text), text);
});

test("CRLF is normalized, and the ends are trimmed", () => {
  assert.equal(validateDescription("  line one\r\nline two\n\n"), "line one\nline two");
});

test("absent, cleared and empty are three inputs but two outcomes", () => {
  // `undefined` is "the caller did not mention it" — PATCH leaves the column.
  assert.equal(validateDescription(undefined), undefined);
  // …while null and "" both mean cleared, stored as one value.
  assert.equal(validateDescription(null), null);
  assert.equal(validateDescription(""), null);
  assert.equal(validateDescription("   \n  "), null);
});

test("the length cap is enforced, at the boundary", () => {
  const atLimit = "x".repeat(MAX_DESCRIPTION);
  assert.equal(validateDescription(atLimit), atLimit);
  assert.ok(isValidationError(validateDescription("x".repeat(MAX_DESCRIPTION + 1))));
  assert.match(validateDescription("x".repeat(MAX_DESCRIPTION + 1)).error, /4000 characters or fewer/);
});

test("a non-string description is refused rather than coerced", () => {
  for (const raw of [42, true, {}, []]) {
    assert.ok(isValidationError(validateDescription(raw)), JSON.stringify(raw));
  }
});

test("markdown is stored verbatim — no escaping, no stripping", () => {
  // The renderer emits typed nodes and builds React elements, so there is no
  // raw-HTML path to defend against here; escaping would only corrupt the source.
  const text = "**bold** and <b>not html</b> and [a link](https://handsontable.com)";
  assert.equal(validateDescription(text), text);
});

test("isValidationError narrows only actual errors", () => {
  assert.equal(isValidationError("text"), false);
  assert.equal(isValidationError(null), false);
  assert.equal(isValidationError(undefined), false);
  assert.equal(isValidationError({ error: "nope" }), true);
});
