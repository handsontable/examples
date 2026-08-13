// An AI styling answer that changes nothing must not report success (DEV-2497).
//
// The reported bug: "corporate green" returned a complete, correct green brand
// ramp, the panel applied all six steps, the grid rendered pixel-identical — and
// the panel said "Applied a corporate green palette." The brand ramp reaches only
// interaction states, so there was nothing to see until you clicked a cell.
// `mergeSuggestion` is what lets the panel tell those apart.
//
// Run through the tmp-dir harness theme-wiring.test.mjs uses: the module tree is
// TypeScript importing siblings by `.js` specifier, which plain `node --test`
// will not resolve.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run `script` against a copy of `theme/` with the `.js` specifiers rewritten,
 *  and parse the JSON it prints. */
function inTheme(script) {
  const dir = mkdtempSync(join(tmpdir(), "hot-suggestion-"));
  try {
    cpSync(join(root, "apps/authoring/src/theme"), join(dir, "theme"), { recursive: true });
    // Required, not optional: `presets.ts` imports Handsontable's static preset
    // data, and without this every import throws and each test below reports as
    // *skipped* — which reads exactly like a green run.
    symlinkSync(join(root, "apps/authoring/node_modules"), join(dir, "node_modules"), "dir");
    for (const file of readdirSync(join(dir, "theme"))) {
      if (!file.endsWith(".ts")) continue;
      const path = join(dir, "theme", file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll('.js"', '.ts"'));
    }
    writeFileSync(join(dir, "run.mjs"), script);
    const out = execFileSync(process.execPath, ["--experimental-strip-types", join(dir, "run.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GREEN_RAMP = {
  "primary.100": "#e6f4ea",
  "primary.200": "#b9dfc4",
  "primary.300": "#7dbf90",
  "primary.400": "#3d9e58",
  "primary.500": "#1a7a38",
  "primary.600": "#0d5225",
};

/** One child run covering every case, so the harness cost is paid once. */
const RESULTS = inTheme(`
  import { mergeSuggestion } from "./theme/suggestion.ts";
  import { DEFAULT_THEME } from "./theme/vocabulary.ts";

  const GREEN_RAMP = ${JSON.stringify(GREEN_RAMP)};
  const run = (answer, state = DEFAULT_THEME) => {
    const { next, effect } = mergeSuggestion(state, answer);
    return { effect, params: next.params, palette: next.palette, colors: next.colors };
  };

  console.log(JSON.stringify({
    refusal: run({ message: "I only restyle grids." }),
    rampOnly: run({ message: "Green.", tokens: {}, palette: GREEN_RAMP }),
    rampWithHeader: run({
      message: "Green.",
      tokens: { headerBackgroundColor: "#e6f4ea", headerRowBackgroundColor: "#e6f4ea" },
      palette: GREEN_RAMP,
    }),
    fontOnly: run({ message: "Smaller.", tokens: { fontSize: "11px" } }),
    presetOnly: run({ message: "Material.", config: { colors: "material" } }),
    alreadySet: run(
      { message: "Green.", palette: GREEN_RAMP },
      { ...DEFAULT_THEME, palette: GREEN_RAMP },
    ),
    followUp: run(
      { message: "Darker header.", tokens: { headerBackgroundColor: "#0d5225" } },
      { ...DEFAULT_THEME, palette: GREEN_RAMP, params: { fontSize: "11px" } },
    ),
  }));
`);

test("a refusal that sets nothing is reported as nothing", () => {
  assert.equal(RESULTS.refusal.effect, "none");
});

// The reported bug, in one assertion.
test("a brand ramp alone is real but invisible at rest", () => {
  assert.equal(RESULTS.rampOnly.effect, "interactionOnly");
  assert.equal(RESULTS.rampOnly.palette["primary.500"], "#1a7a38", "the ramp is still applied");
});

test("the same ramp with a header tint is visible", () => {
  assert.equal(RESULTS.rampWithHeader.effect, "visible");
});

test("a change with no colour in it at all still counts as visible", () => {
  assert.equal(RESULTS.fontOnly.effect, "visible");
});

test("switching the colours preset is visible on its own", () => {
  assert.equal(RESULTS.presetOnly.effect, "visible");
  assert.equal(RESULTS.presetOnly.colors, "material");
});

test("re-applying the theme that is already set changes nothing", () => {
  assert.equal(RESULTS.alreadySet.effect, "none");
});

test("a follow-up refines rather than resets", () => {
  assert.equal(RESULTS.followUp.effect, "visible");
  assert.equal(RESULTS.followUp.params.fontSize, "11px", "the earlier token survives");
  assert.equal(RESULTS.followUp.palette["primary.500"], "#1a7a38", "and so does the earlier ramp");
});
