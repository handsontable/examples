// The Style panel shows preset colours in native colour inputs (DEV-2560), and
// the presets are 8-digit hex while the inputs only take `#rrggbb`. Every
// control that paints a swatch goes through `hexInputValue`, so a regression
// here is a panel full of black squares.
//
// Imported directly rather than through the tmp-dir harness the codegen tests
// use: `theme/color.ts` has no imports precisely so this is possible.
import test from "node:test";
import assert from "node:assert/strict";

const { hexInputValue, isTransparentHex } = await import("../apps/authoring/src/theme/color.ts");

test("an 8-digit preset colour loses its alpha", () => {
  assert.equal(hexInputValue("#1a42e8ff"), "#1a42e8");
  assert.equal(hexInputValue("#F7F7F9FF"), "#f7f7f9");
});

test("a 6-digit colour passes through, lowercased", () => {
  assert.equal(hexInputValue("#1A42E8"), "#1a42e8");
  assert.equal(hexInputValue("  #1a42e8  "), "#1a42e8", "trimmed");
});

test("shorthand is expanded", () => {
  assert.equal(hexInputValue("#fff"), "#ffffff");
  assert.equal(hexInputValue("#f00a"), "#ff0000", "the alpha nibble is dropped");
});

test("anything that is not a hex colour falls back", () => {
  // These are all real token values: a raw rgba(), the CSS keyword, a variable
  // reference, an unresolved `colors.*` reference, and an unset control.
  for (const value of ["rgba(0, 0, 0, .5)", "transparent", "var(--brand)", "colors.primary.500", "", "#12345", undefined]) {
    assert.equal(hexInputValue(value), "#000000", `${String(value)} must fall back`);
  }
});

test("the fallback is the caller's — a ramp swatch wants white, a token black", () => {
  assert.equal(hexInputValue("", "#ffffff"), "#ffffff");
  assert.equal(hexInputValue("not a colour", "#ffffff"), "#ffffff");
});

test("a fully transparent preset colour is recognised", () => {
  // `colors/main` ships `transparent: "#ffffff00"`, which normalises to plain
  // white — the swatch has to say otherwise.
  assert.equal(hexInputValue("#ffffff00"), "#ffffff");
  assert.equal(isTransparentHex("#ffffff00"), true);
  assert.equal(isTransparentHex("#fff0"), true);
});

test("an opaque or non-hex colour is not transparent", () => {
  for (const value of ["#1a42e8ff", "#1a42e8", "#fff", "transparent", "", undefined]) {
    assert.equal(isTransparentHex(value), false, `${String(value)} must not read as transparent`);
  }
});
