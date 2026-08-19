// The batched drop commit (DEV-2500). The ticket calls the batched `onAddFiles`
// necessary, not cosmetic — N sequential `addFile` calls would be N `setFiles`
// renders and N container pushes each invalidating the last — yet until now the
// contract survived only as a code comment; a per-file loop would have passed
// every existing e2e (they only check the rows appear). Two halves here:
// `applyDroppedFiles` (the pure map transform `App.tsx` commits) imported and
// exercised directly, and a source grep holding `App.tsx`'s `addFiles` to the
// one-commit shape.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyDroppedFiles } from "../apps/authoring/src/addFiles.ts";

test("a drop lands as one new files map, not N", () => {
  const current = { "/index.ts": "entry", "/styles.css": "body {}" };
  const snapshot = structuredClone(current);
  const next = applyDroppedFiles(current, [
    { path: "/a.ts", contents: "A" },
    { path: "/b.css", contents: "B" },
    { path: "/data/rows.json", contents: "[]" },
  ]);
  // A NEW map: this one object is the whole commit — one setFiles, one rebuild.
  assert.notEqual(next, current);
  assert.deepEqual(next, {
    "/index.ts": "entry",
    "/styles.css": "body {}",
    "/a.ts": "A",
    "/b.css": "B",
    "/data/rows.json": "[]",
  });
  // ...and the input was read, never written.
  assert.deepEqual(current, snapshot);
});

test("a colliding path is overwritten in place", () => {
  // By the time a batch reaches this helper the FILES tree has already asked
  // ("Overwrite" vs "Keep both") and "Keep both" renamed before the call — see
  // FileTree's commit(). A collision arriving here therefore means overwrite.
  const current = { "/index.ts": "old", "/other.ts": "kept" };
  const next = applyDroppedFiles(current, [{ path: "/index.ts", contents: "new" }]);
  assert.deepEqual(next, { "/index.ts": "new", "/other.ts": "kept" });
  // Overwritten in the new map; the input still holds the old contents.
  assert.equal(current["/index.ts"], "old");
});

test("an empty drop returns the same map", () => {
  // Reference-equal on purpose: App.tsx compares against filesRef.current and
  // skips the whole commit when nothing was dropped.
  const current = { "/index.ts": "entry" };
  assert.equal(applyDroppedFiles(current, []), current);
});

// ---- the source guard: App.tsx's addFiles keeps the one-commit shape --------

/**
 * Slice `addFiles`'s whole `useCallback(...)` argument list out of App.tsx by
 * balanced-paren scan. Honest fragility note: the scan counts every `(` and
 * `)` including those inside comments and strings — today they all come in
 * pairs, and the sanity assertions below (the slice ends, and contains the
 * pieces it must) turn a formatting change that breaks the scan into a loud
 * failure here rather than a silent pass.
 */
function addFilesSlice(source) {
  const marker = "const addFiles = useCallback(";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "App.tsx no longer declares `const addFiles = useCallback(`");
  assert.equal(source.indexOf(marker, start + 1), -1, "expected exactly one addFiles declaration");
  let depth = 0;
  for (let i = start + marker.length - 1; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  assert.fail("unbalanced parens scanning addFiles — fix the slice helper, not the assertion");
}

test("App.tsx's addFiles keeps the one-commit shape", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const app = readFileSync(join(root, "apps/authoring/src/App.tsx"), "utf8");
  const body = addFilesSlice(app);

  // Sanity: the slice really is the drop handler, whole.
  assert.match(body, /markDirty\(/, "slice lost the dirty marking — the scan broke");
  assert.match(body, /writeFile\(/, "slice lost the runtime writes — the scan broke");

  // The contract: the map math goes through the tested helper...
  assert.match(body, /applyDroppedFiles\(/, "addFiles must build its map via applyDroppedFiles");
  // ...and lands as ONE state commit. Two `setFiles(` here means the batch
  // regressed to a loop — exactly what DEV-2500 exists to prevent.
  assert.equal(
    (body.match(/setFiles\(/g) ?? []).length,
    1,
    "addFiles must call setFiles exactly once per drop",
  );
  // One ref commit too ([^=] keeps `next === filesRef.current` from matching).
  assert.equal(
    (body.match(/filesRef\.current\s*=[^=]/g) ?? []).length,
    1,
    "addFiles must assign filesRef.current exactly once per drop",
  );
});
