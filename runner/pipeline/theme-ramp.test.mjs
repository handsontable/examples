// A half-supplied colour ramp must not reach the panel with holes in it
// (DEV-2197). The missing steps deep-merge from the preset, so a navy recolour
// keeps one preset-blue rung in the middle and looks like a rendering fault.
//
// Imported directly rather than through the tmp-dir harness the codegen tests
// use: `theme-ramp.ts` has no imports precisely so this is possible.
import test from "node:test";
import assert from "node:assert/strict";

const { completeRamp, PRIMARY_RAMP, NEUTRAL_RAMP } = await import("../workers/api/src/theme-ramp.ts");

const ramp = (entries) => Object.fromEntries(entries);

test("a complete ramp is returned untouched", () => {
  const full = ramp(PRIMARY_RAMP.map((s, i) => [s, `#${String(i).repeat(6)}`]));
  assert.deepEqual(completeRamp(full, PRIMARY_RAMP), full);
});

test("a gap is filled between the steps it sits between", () => {
  // The reported case: 200 missing from an otherwise complete brand ramp.
  const supplied = { 100: "#000000", 300: "#ff0000", 400: "#ff0000", 500: "#ff0000", 600: "#ff0000" };
  const filled = completeRamp(supplied, PRIMARY_RAMP);

  assert.equal(Object.keys(filled).length, 6, "every step must be present");
  // Halfway between 100 and 300 on the red channel, and untouched elsewhere.
  assert.equal(filled["200"], "#800000");
  for (const step of ["100", "300", "400", "500", "600"]) {
    assert.equal(filled[step], supplied[step], `${step} must not be rewritten`);
  }
});

test("a gap past either end clamps to its nearest neighbour", () => {
  const filled = completeRamp({ 300: "#102030", 400: "#405060" }, PRIMARY_RAMP);
  assert.equal(filled["100"], "#102030", "below the lowest supplied step");
  assert.equal(filled["200"], "#102030");
  assert.equal(filled["500"], "#405060", "above the highest");
  assert.equal(filled["600"], "#405060");
});

test("a single step is left alone", () => {
  // One step on its own is a deliberate single-colour change, not a broken
  // recolour — inventing five colours around it is a worse answer.
  const supplied = { 500: "#7e22ce" };
  assert.deepEqual(completeRamp(supplied, PRIMARY_RAMP), supplied);
});

test("an empty ramp stays empty", () => {
  assert.deepEqual(completeRamp({}, PRIMARY_RAMP), {});
});

test("the neutral scale interpolates on the step number, not its position", () => {
  // 50, 100, 200 … 900, 950: the ends are half-steps, so filling 950 from 900
  // and 900 is not the same as filling it from the previous list *index*.
  const filled = completeRamp({ 900: "#000000", 100: "#ffffff", 50: "#ffffff" }, NEUTRAL_RAMP);
  assert.equal(Object.keys(filled).length, NEUTRAL_RAMP.length);
  // 500 is exactly half of the way from 100 to 900.
  assert.equal(filled["500"], "#808080");
  // 300 is a quarter of the way, so it stays nearer white than 500 does.
  assert.equal(filled["300"], "#bfbfbf");
});

test("a malformed value is treated as absent, not interpolated from", () => {
  // The whitelist upstream drops these, but a ramp that arrives with one and
  // is otherwise complete must still come out whole rather than propagate it.
  const filled = completeRamp({ 100: "#000000", 200: "rgb(1,2,3)", 300: "#ff0000" }, PRIMARY_RAMP);
  assert.equal(filled["200"], "#800000", "the bad value is replaced, not kept");
  assert.ok(Object.values(filled).every((v) => /^#[0-9a-f]{6}$/i.test(v)));
});

test("alpha survives a ramp that carries it", () => {
  const filled = completeRamp({ 100: "#00000000", 300: "#ff0000ff" }, PRIMARY_RAMP);
  assert.equal(filled["200"], "#80000080");
});

// The unit tests above all pass with `completeRamp` wired to the wrong prefix,
// or not called at all. This is the one that fails if the two never meet.
// theme-ai.ts reaches env.ts and chat.ts by `.js` specifier, so the sources are
// copied and the specifiers rewritten — the harness theme-wiring.test.mjs uses.
const sanitise = await (async () => {
  const { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "workers/api/src");
  const dir = mkdtempSync(join(tmpdir(), "hot-theme-ai-"));
  for (const file of readdirSync(src)) {
    if (!file.endsWith(".ts")) continue;
    writeFileSync(join(dir, file), readFileSync(join(src, file), "utf8").replaceAll('.js"', '.ts"'));
  }
  return (await import(join(dir, "theme-ai.ts"))).sanitiseSuggestion;
})();

test("a suggestion with a gapped brand ramp comes out whole", () => {
  // Verbatim the reported failure: "corporate navy blue" returned five of six
  // primary steps, and the missing one fell back to the preset's blue.
  const { palette } = sanitise({
    message: "Applied a corporate navy blue palette.",
    palette: {
      "primary.100": "#e6ecf5",
      "primary.300": "#8fa8cc",
      "primary.400": "#4a6fa5",
      "primary.500": "#1e3a5f",
      "primary.600": "#12243c",
    },
  });

  for (const step of ["100", "200", "300", "400", "500", "600"]) {
    assert.match(palette[`primary.${step}`] ?? "", /^#[0-9a-f]{6}$/i, `primary.${step} is missing`);
  }
  assert.equal(palette["primary.500"], "#1e3a5f", "the supplied steps must survive verbatim");
});

test("a single palette step still reaches the panel alone", () => {
  const { palette } = sanitise({ message: "Redder header.", palette: { "primary.500": "#ff0000" } });
  assert.deepEqual(palette, { "primary.500": "#ff0000" });
});

// A brand recolour that nothing on screen shows (DEV-2497). The primary ramp
// reaches 38 of the 279 tokens, and every one of them is an interaction state —
// selection, focus, active header, checkbox. A resting grid paints primary
// nowhere, so "corporate green" applied perfectly and looked like a no-op.
test("a brand ramp alone tints the header, so the recolour is visible at rest", () => {
  // Verbatim the reproduced payload: complete green ramp, empty `tokens`.
  const { tokens } = sanitise({
    message: "Applied a corporate green palette.",
    tokens: {},
    palette: {
      "primary.100": "#e6f4ea",
      "primary.200": "#b9dfc4",
      "primary.300": "#7dbf90",
      "primary.400": "#3d9e58",
      "primary.500": "#1a7a38",
      "primary.600": "#0d5225",
    },
  });

  // A `[light, dark]` pair of ramp references, the shape the presets themselves
  // use (`accentColor` is `["colors.primary.500","colors.primary.300"]`). A bare
  // light hex would apply to both schemes, and a dark grid resolves its header
  // foreground to `palette.200` — light grey on pale mint, about 1.7:1.
  assert.deepEqual(
    tokens.headerBackgroundColor,
    ["colors.primary.100", "colors.primary.600"],
    "the header follows the ramp, light end in light and dark end in dark",
  );
  assert.deepEqual(
    tokens.headerRowBackgroundColor,
    ["colors.primary.100", "colors.primary.600"],
    "and so does its linked row-header pair",
  );
});

test("a ramp the model half-supplied still earns the tint once it is completed", () => {
  const { tokens } = sanitise({
    message: "Navy.",
    palette: {
      "primary.100": "#e6ecf5",
      "primary.300": "#8fa8cc",
      "primary.400": "#4a6fa5",
      "primary.500": "#1e3a5f",
      "primary.600": "#12243c",
    },
  });

  assert.deepEqual(tokens.headerBackgroundColor, ["colors.primary.100", "colors.primary.600"]);
});

test("a resting surface the model set itself is never overridden", () => {
  const { tokens } = sanitise({
    message: "Green, with a white header.",
    tokens: { headerBackgroundColor: "#ffffff" },
    palette: {
      "primary.100": "#e6f4ea",
      "primary.200": "#b9dfc4",
      "primary.300": "#7dbf90",
      "primary.400": "#3d9e58",
      "primary.500": "#1a7a38",
      "primary.600": "#0d5225",
    },
  });

  assert.equal(tokens.headerBackgroundColor, "#ffffff");
  assert.equal(tokens.headerRowBackgroundColor, undefined, "the pairing is the model's call, not ours");
});

test("a single step is a deliberate accent change, not a recolour", () => {
  const { tokens } = sanitise({ message: "Green selection.", palette: { "primary.500": "#1a7a38" } });
  assert.deepEqual(tokens, {});
});

// Where the two safety nets compose badly if the floor is not aimed carefully.
// `completeRamp` fills from two supplied steps, so "darker green selection
// border" — a legitimate two-step accent tweak — arrives at the floor as a
// *complete* ramp. Tinting from it repaints the header in a mid-tone green
// (`fillRamp` clamps step 100 to its nearest neighbour), which is not what was
// asked for. The floor is for a model that meant all six and lost one.
test("a two-step accent tweak completed into a ramp does not tint the header", () => {
  const { tokens, palette } = sanitise({
    message: "Darker green selection border.",
    palette: { "primary.400": "#3d9e58", "primary.500": "#1a7a38" },
  });

  assert.deepEqual(tokens, {}, "an accent tweak must not repaint the header");
  assert.equal(Object.keys(palette).length, 6, "the ramp is still completed, as DEV-2197 requires");
});

test("a token-only answer is left exactly as it came", () => {
  const { tokens } = sanitise({ message: "Red header.", tokens: { headerBackgroundColor: "#ff0000" } });
  assert.deepEqual(tokens, { headerBackgroundColor: "#ff0000" });
});
