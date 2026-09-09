// The DEMOS-1D editor trail (DEV-2859): a bounded ring buffer with
// consecutive-identical coalescing, replacing a rejected one-breadcrumb-per-
// `onEdit` design that would have let a "Maximum update depth exceeded" loop
// evict the very context it exists to preserve.
//
// Imported straight from the .ts, the way `pipeline/session-diagnostics.test.mjs`
// imports `sessionDiagnostics.ts` — `editorTrail.ts` must stay import-free for
// the same reason (a sibling `./x.js` specifier does not resolve under
// `--experimental-strip-types`, verified empirically against a throwaway probe
// file).

import test from "node:test";
import assert from "node:assert/strict";
import {
  recordEditorEvent,
  snapshotEditorTrail,
  editorTrailTags,
  resetEditorTrail,
  __setClockForTest,
} from "../apps/authoring/src/editorTrail.ts";

function useFakeClock(t, step = 1) {
  let now = 0;
  __setClockForTest(() => { now += step; return now; });
  t.after(() => __setClockForTest(null));
}

test.beforeEach(() => resetEditorTrail());

test("a plain edit is recorded with an incrementing seq", (t) => {
  useFakeClock(t);
  recordEditorEvent({ kind: "edit", source: "editor", path: "/index.js", quiet: false, size: 10 });
  recordEditorEvent({ kind: "edit", source: "editor", path: "/other.js", quiet: false, size: 12 });
  const snap = snapshotEditorTrail();
  assert.equal(snap.length, 2);
  assert.ok(snap[1].seq > snap[0].seq);
});

test("same path, same signature: two writes coalesce (size does not break coalescing)", (t) => {
  useFakeClock(t);
  recordEditorEvent({ kind: "edit", source: "editor", path: "/index.js", quiet: false, size: 10 });
  recordEditorEvent({ kind: "edit", source: "editor", path: "/index.js", quiet: false, size: 12 });
  const snap = snapshotEditorTrail();
  // `size` is deliberately excluded from the coalescing signature (see
  // editorTrail.ts's `signature`): a tight loop over a shrinking/growing
  // buffer must still collapse into one slot, or the whole design would be
  // defeated by the exact shape it exists to handle.
  assert.equal(snap.length, 1);
  assert.equal(snap[0].n, 2);
  assert.equal(snap[0].size, 12); // the latest size wins
});

test("capacity + 5 distinct entries: the oldest is evicted", (t) => {
  useFakeClock(t);
  for (let i = 0; i < 29; i++) {
    // A distinct signature every time (differing path), so nothing coalesces
    // and this exercises the eviction path, not the coalescing one.
    recordEditorEvent({ kind: "edit", source: "editor", path: `/file-${i}.js`, quiet: false, size: i });
  }
  const snap = snapshotEditorTrail();
  assert.equal(snap.length, 24); // CAPACITY
  // The oldest 5 (file-0..file-4) are gone; the newest (file-28) survived.
  assert.equal(snap.some((e) => e.path === "/file-0.js"), false);
  assert.equal(snap.some((e) => e.path === "/file-4.js"), false);
  assert.equal(snap[snap.length - 1].path, "/file-28.js");
  assert.equal(snap[0].path, "/file-5.js");
});

test("3000 identical pushes coalesce into ONE entry with n === 3000, and the entry pushed before the loop survives", (t) => {
  useFakeClock(t);
  recordEditorEvent({ kind: "workspace", source: "load", path: "docs", quiet: false, size: 0 });
  for (let i = 0; i < 3000; i++) {
    recordEditorEvent({ kind: "edit", source: "editor", path: "/App.jsx", quiet: false, size: 42 });
  }
  const snap = snapshotEditorTrail();
  // This is the whole design claim: a 3000-iteration loop must occupy exactly
  // one slot, and the entry from before the loop must still be readable —
  // with the rejected per-edit-breadcrumb design (maxBreadcrumbs: 200), both
  // of these would be false: the loop alone would have overflowed 200 distinct
  // slots and evicted the "load" entry long before this assertion.
  assert.equal(snap.length, 2);
  assert.equal(snap[0].kind, "workspace");
  assert.equal(snap[0].source, "load");
  const loopEntry = snap[1];
  assert.equal(loopEntry.kind, "edit");
  assert.equal(loopEntry.source, "editor");
  assert.equal(loopEntry.n, 3000);
});

test("a signature change breaks coalescing into two entries", (t) => {
  useFakeClock(t);
  recordEditorEvent({ kind: "edit", source: "editor", path: "/a.js", quiet: false, size: 1 });
  recordEditorEvent({ kind: "edit", source: "editor", path: "/a.js", quiet: false, size: 2 });
  recordEditorEvent({ kind: "edit", source: "style", path: "/a.js", quiet: false, size: 3 }); // source differs
  const snap = snapshotEditorTrail();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].n, 2);
  assert.equal(snap[0].source, "editor");
  assert.equal(snap[1].n, 1);
  assert.equal(snap[1].source, "style");
});

test("quiet is part of the coalescing signature (a style patch vs. a style reset)", (t) => {
  useFakeClock(t);
  recordEditorEvent({ kind: "edit", source: "style", path: "/theme.js", quiet: true, size: 5 });
  recordEditorEvent({ kind: "edit", source: "style", path: "/theme.js", quiet: false, size: 5 });
  const snap = snapshotEditorTrail();
  assert.equal(snap.length, 2);
});

test("size is length, not contents — the real privacy assertion", (t) => {
  useFakeClock(t);
  const sentinel = "SECRET_VISITOR_SOURCE_MARKER_do_not_leak_this";
  // A caller that (incorrectly) still passes `contents` alongside `size` must
  // not be able to get it into the trail — this module never reads or spreads
  // an unknown property from its input.
  recordEditorEvent({
    kind: "edit",
    source: "editor",
    path: "/index.js",
    quiet: false,
    size: sentinel.length,
    contents: sentinel,
  });
  const snap = snapshotEditorTrail();
  assert.equal(JSON.stringify(snap).includes(sentinel), false);
  assert.equal(snap[snap.length - 1].size, sentinel.length);
});

test("path is capped", (t) => {
  useFakeClock(t);
  const longPath = "/" + "a".repeat(500) + ".js";
  recordEditorEvent({ kind: "edit", source: "editor", path: longPath, quiet: false, size: 1 });
  const snap = snapshotEditorTrail();
  assert.ok(snap[0].path.length <= 121); // 120 + the "…" marker
});

// --- editorTrailTags -------------------------------------------------------

test("editorTrailTags reads the most recent entry", (t) => {
  useFakeClock(t);
  assert.deepEqual(editorTrailTags(), {});
  recordEditorEvent({ kind: "edit", source: "ai", path: "/a.js", quiet: false, size: 1 });
  for (let i = 0; i < 50; i++) {
    recordEditorEvent({ kind: "edit", source: "ai", path: "/a.js", quiet: false, size: 1 });
  }
  const tags = editorTrailTags();
  assert.equal(tags.editor_loop_source, "ai");
  assert.equal(tags.editor_last_kind, "edit");
  assert.equal(tags.editor_loop_n_bucket, "<100");
});

test("editorTrailTags skips a trailing flush-quiet entry (a Style-panel drag ends with one)", (t) => {
  useFakeClock(t);
  // A colour drag: ~200 coalesced quiet writes, then the flush that always
  // follows one (App.tsx's `flushQuietEdits`). Without the fix, reading the
  // bare last entry would report the flush's own source ("style", n=1)
  // instead of the coalesced drag underneath it — hiding the exact signal
  // DEMOS-1D exists to read.
  for (let i = 0; i < 200; i++) {
    recordEditorEvent({ kind: "edit", source: "style", path: "/theme.js", quiet: true, size: 5 });
  }
  recordEditorEvent({ kind: "flush-quiet", source: "style", path: "", quiet: false, size: 0 });
  const tags = editorTrailTags();
  assert.equal(tags.editor_loop_source, "style");
  assert.equal(tags.editor_last_kind, "edit"); // NOT "flush-quiet"
  assert.equal(tags.editor_loop_n_bucket, "<1000"); // the 200-run's bucket, not the flush's n=1
});

test("editorTrailTags falls back to the last entry when the trail is nothing but flushes", (t) => {
  useFakeClock(t);
  recordEditorEvent({ kind: "flush-quiet", source: "style", path: "", quiet: false, size: 0 });
  const tags = editorTrailTags();
  assert.equal(tags.editor_last_kind, "flush-quiet");
});

test("editorTrailTags n_bucket boundaries", (t) => {
  const cases = [
    [1, "<10"],
    [9, "<10"],
    [10, "<100"],
    [99, "<100"],
    [100, "<1000"],
    [999, "<1000"],
    [1000, ">=1000"],
  ];
  for (const [n, expected] of cases) {
    resetEditorTrail();
    useFakeClock(t);
    for (let i = 0; i < n; i++) {
      recordEditorEvent({ kind: "edit", source: "editor", path: "/a.js", quiet: false, size: 1 });
    }
    assert.equal(editorTrailTags().editor_loop_n_bucket, expected, `n=${n}`);
  }
});
