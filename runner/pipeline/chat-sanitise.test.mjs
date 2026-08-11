// The answer whitelist (`workers/api/src/chat.ts`). What it must keep is as
// much the point as what it drops (DEV-2217): it used to strip every `<…>` from
// the prose, which deleted `<HotTable>` and `<HotColumn>` — the two most common
// technical tokens in an answer about a React data grid — backticks included.
//
// chat.ts reaches env.ts by `.js` specifier, which plain node will not resolve
// from a `.ts` file, so the sources are copied and the specifiers rewritten —
// the harness pipeline/theme-wiring.test.mjs uses.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "workers/api/src");
const dir = mkdtempSync(join(tmpdir(), "hot-chat-"));
for (const file of readdirSync(src)) {
  if (!file.endsWith(".ts")) continue;
  writeFileSync(join(dir, file), readFileSync(join(src, file), "utf8").replaceAll('.js"', '.ts"'));
}
const { sanitiseAnswer } = await import(join(dir, "chat.ts"));

const REQUEST = { messages: [], framework: "react", files: { "src/index.tsx": "" } };
const answer = (raw) => sanitiseAnswer(raw, REQUEST, 0);

test("a JSX component name survives the prose", () => {
  // The reported sentence, verbatim in shape: the strip left "the `` component".
  const { message } = answer({
    message: "I've added `fixedColumnsStart={2}` to the `<HotTable>` component.",
  });
  assert.match(message, /`<HotTable>`/);
  assert.doesNotMatch(message, /``/, "an emptied code span is the defect");
});

test("a component name survives an edit's rationale", () => {
  const { edits } = answer({
    message: "Done.",
    edits: [{ path: "src/index.tsx", contents: "// x\n", why: "adds <HotColumn> for the new column" }],
  });
  assert.equal(edits[0].why, "adds <HotColumn> for the new column");
});

test("markup reaches the reader as text rather than being deleted", () => {
  // The sink escapes: markdown.tsx builds React elements and never touches
  // innerHTML. So this must arrive intact and render as visible characters —
  // silently swallowing it is what hid the bug above.
  const { message } = answer({ message: "Never write <script>alert(1)</script> in a cell renderer." });
  assert.match(message, /<script>alert\(1\)<\/script>/);
});

test("the length caps still apply", () => {
  const { message } = answer({ message: "x".repeat(10_000) });
  assert.equal(message.length, 6_000);

  const { edits } = answer({
    message: "Done.",
    edits: [{ path: "src/index.tsx", contents: "// x\n", why: "y".repeat(500) }],
  });
  assert.equal(edits[0].why.length, 200);
});

test("a missing message still has a default", () => {
  assert.equal(answer({}).message, "Done.");
  assert.equal(answer({ message: 42 }).message, "Done.");
});

test("the rest of the whitelist is untouched", () => {
  // Path re-validation and the lockfile rule are the parts that actually guard
  // something; this fix must not have loosened them.
  const { edits } = answer({
    message: "Done.",
    edits: [
      { path: "../../etc/passwd", contents: "x" },
      { path: "pnpm-lock.yaml", contents: "x" },
      { path: "src/new.tsx", contents: "ok\n" },
    ],
  });
  assert.deepEqual(edits.map((e) => e.path), ["src/new.tsx"]);
});
