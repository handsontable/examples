// The theme module is generated source that a demo then evaluates, so anything
// interpolated into it is a script-injection surface (DEV-2199).
//
// Read as text rather than imported: codegen.ts is TypeScript importing sibling
// modules by `.js` specifier, which doesn't resolve under plain `node --test`.
// The rule it enforces is structural, so text is enough — and it holds for keys
// that no test would think to supply, which is the point.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const codegen = readFileSync(join(root, "apps/authoring/src/theme/codegen.ts"), "utf8");

test("every interpolated object key in generated source goes through lit()", () => {
  // `${expr}: ` — the shape of an object-literal key being written out. The
  // lookahead keeps the match to the innermost `${...}`, so a key emitted from
  // inside a nested template literal is still seen on its own.
  const keys = [...codegen.matchAll(/\$\{((?:(?!\$\{)[^}])*)\}:\s/g)].map((m) => m[1].trim());
  assert.ok(keys.length >= 4, "expected to find the key-emitting template lines");
  const unescaped = keys.filter((expr) => !expr.startsWith("lit("));
  assert.deepEqual(
    unescaped,
    [],
    "an unquoted key closes the object literal exactly as an unquoted value does — wrap it in lit()",
  );
});

test("preset ramps are spread by bracket notation, not member access", () => {
  // `...colorsPreset.primary` pastes a ramp name into member access; a dotted
  // palette key would break out of it.
  assert.ok(
    !/\.\.\.\$\{presetVar\}\.\$\{/.test(codegen),
    "use ...${presetVar}[${lit(ramp)}] so the ramp name stays data",
  );
  assert.match(codegen, /\.\.\.\$\{presetVar\}\[\$\{lit\(ramp\)\}\]/);
});
