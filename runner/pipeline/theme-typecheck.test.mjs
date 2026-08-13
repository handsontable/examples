// The generated theme module has to survive a type-checking build (DEV-2216).
//
// Angular is the only starter whose dev server type-checks — every other one
// strips types and never looks at them. So a type error in the module the Style
// panel writes failed the Angular build outright, and a failed build is
// invisible from the outside: the dev server keeps serving the last good bundle,
// the grid stays on its original theme, nothing appears in the browser console,
// and a reload changes nothing. Worse, the broken module stays on disk, so
// *every subsequent edit* to that demo is silently swallowed too — which is how
// this was first reported ("no file edit ever reaches the Angular preview").
//
// Four errors were in the emitted source, and no text assertion would have
// caught them all: `density`/`colorScheme` widening to `string`, the same for
// `density.type`, spreading a preset ramp typed `string | Record<…>`, and
// `getTheme()` being `ThemeBuilder | undefined` at `.params(…)`. So this runs
// the real compiler against the real Handsontable types.
//
// codegen.ts is TypeScript importing siblings by `.js` specifier, so — as in
// theme-wiring.test.mjs — the module tree is copied to a temp dir with the
// specifiers rewritten and executed with type stripping.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Handsontable's own `.d.ts` files — the point of the exercise. */
const modules = join(root, "apps/authoring/node_modules");
const tsc = join(root, "node_modules/typescript/bin/tsc");

/** One state per branch of the generator, so no emitted line goes unchecked. */
const SCRIPT = `
import { buildThemeModule } from "./theme/codegen.ts";
import { DEFAULT_THEME } from "./theme/vocabulary.ts";

const states = {
  // The panel's opening position: presets only, no overrides.
  plain: { ...DEFAULT_THEME },
  // Token overrides, so the '.params({…})' branch is emitted, plus the two
  // literals that used to widen to 'string'.
  tokens: {
    ...DEFAULT_THEME,
    colorScheme: "dark",
    density: "comfortable",
    params: { accentColor: "#1A42E8", fontFamily: "Inter" },
  },
  // A palette ramp (spread out of the preset) and per-variant density sizes,
  // which nest a second 'type' literal inside the density object.
  palette: {
    ...DEFAULT_THEME,
    density: "compact",
    palette: { "primary.500": "#1A42E8", backgroundColor: "#FFFFFF" },
    densitySizes: { compact: { gap: "sizing.size_1" } },
  },
};

const out = {};
for (const [name, state] of Object.entries(states)) {
  out[name] = {
    ts: buildThemeModule(state, true),
    js: buildThemeModule(state, false),
    // The demo's own copy carries the live-patch bridge (DEV-2496), and that block
    // is type-checked too: it calls '.params()' on 'getTheme()', which is exactly
    // the 'ThemeBuilder | undefined' error that broke the Angular build before.
    tsBridge: buildThemeModule(state, true, { bridge: true }),
    jsBridge: buildThemeModule(state, false, { bridge: true }),
  };
}
console.log(JSON.stringify(out));
`;

function runCodegen(script) {
  const dir = mkdtempSync(join(tmpdir(), "hot-theme-tc-"));
  try {
    cpSync(join(root, "apps/authoring/src/theme"), join(dir, "theme"), { recursive: true });
    // `presets.ts` imports Handsontable's static preset JSON, so the copied tree needs
    // the real package to resolve. Without it the import throws and every test in this
    // file reports as skipped — a green-looking run that checked nothing.
    symlinkSync(modules, join(dir, "node_modules"), "dir");
    for (const file of readdirSync(join(dir, "theme"))) {
      if (!file.endsWith(".ts")) continue;
      const path = join(dir, "theme", file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll('.js"', '.ts"'));
    }
    writeFileSync(join(dir, "run.mjs"), script);
    return execFileSync(process.execPath, ["--experimental-strip-types", join(dir, "run.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let modules_ = null;
let skip = false;
if (!existsSync(join(modules, "handsontable"))) {
  skip = "handsontable is not installed here — run pnpm install in runner/apps/authoring";
} else if (!existsSync(tsc)) {
  skip = "typescript is not installed here — run pnpm install in runner";
} else {
  try {
    modules_ = JSON.parse(runCodegen(SCRIPT).trim().split("\n").at(-1));
  } catch (err) {
    skip = `codegen could not be executed here: ${err.message.split("\n")[0]}`;
  }
}

/** Compile the given sources together, as the demo's own build would. */
function typecheck(sources) {
  const dir = mkdtempSync(join(tmpdir(), "hot-theme-tsc-"));
  try {
    // Symlinked rather than copied: this is a few hundred megabytes of types.
    symlinkSync(modules, join(dir, "node_modules"), "dir");
    for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, `${name}.ts`), source);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      // The Angular starter's settings, which are the strict ones that matter.
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        lib: ["ES2022", "dom"],
      },
    }));
    execFileSync(process.execPath, [tsc, "--project", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    // tsc reports on stdout and exits nonzero.
    return `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the generated TypeScript module compiles against Handsontable's types", { skip }, () => {
  const errors = typecheck(Object.fromEntries(
    Object.entries(modules_).flatMap(([name, { ts, tsBridge }]) => [
      [name, ts],
      [`${name}-bridge`, tsBridge],
    ]),
  ));
  assert.equal(
    errors,
    null,
    "a type error here fails the Angular build, and a failed build is invisible:\n"
    + "the preview keeps serving the last good bundle with no console error.\n"
    + `${errors}`,
  );
});

test("the JavaScript module carries no TypeScript-only syntax", { skip }, () => {
  // The same generator writes `handsontable-theme.js` for the JS starters, and
  // an annotation or an `as` cast there is a syntax error before anything runs.
  for (const [state, variants] of Object.entries(modules_)) {
    // The bridge variant included: it is the copy the demo actually evaluates, and it
    // is the one carrying an annotated parameter and a cast under TypeScript.
    for (const key of ["js", "jsBridge"]) {
      const js = variants[key];
      const name = `${state}/${key}`;
      assert.doesNotMatch(js, /\bimport type\b/, `${name}: a type import cannot appear in a .js module`);
      assert.doesNotMatch(js, /\bas Record</, `${name}: a cast cannot appear in a .js module`);
      assert.doesNotMatch(js, /^const config:/m, `${name}: an annotation cannot appear in a .js module`);
      assert.doesNotMatch(js, /getTheme\(THEME_NAME\)!/, `${name}: a non-null assertion cannot appear in a .js module`);
      assert.doesNotMatch(js, /\bevent: MessageEvent\b/, `${name}: an annotation cannot appear in a .js module`);
      assert.doesNotMatch(js, /\bas Window\b/, `${name}: a cast cannot appear in a .js module`);

      const dir = mkdtempSync(join(tmpdir(), "hot-theme-js-"));
      try {
        const file = join(dir, "module.mjs");
        writeFileSync(file, js);
        execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("the bridge is in the demo's module and out of the copy-for-my-app snippet", { skip }, () => {
  for (const [state, variants] of Object.entries(modules_)) {
    assert.match(
      variants.jsBridge,
      /addEventListener\('message'/,
      `${state}: the demo's copy needs the live-patch listener, or every theme edit rebuilds`,
    );
    assert.doesNotMatch(
      variants.js,
      /addEventListener\('message'/,
      `${state}: the snippet is what a user pastes into their app — no playground plumbing in it`,
    );
    // Guarded, so a downloaded demo (and Astro's server render) never runs it.
    assert.match(variants.jsBridge, /typeof window !== 'undefined' && window\.parent !== window/);
    // Not window.top: the runner itself is framed in embed mode.
    assert.doesNotMatch(variants.jsBridge, /window\.top/);
    // A rejected patch must be reported, not thrown — the listener has to survive a
    // half-typed colour or the panel is left waiting on a bridge that is already dead.
    assert.match(variants.jsBridge, /try \{[\s\S]*\.params\(data\.params\);[\s\S]*\} catch \{/);
    // Answered to the sender, which is right whatever the frame nesting turns out to be.
    assert.match(variants.jsBridge, /event\.source\?\.postMessage\(\{ source: "hot-runner-theme", ack: data\.id, ok \}/);
  }
});
