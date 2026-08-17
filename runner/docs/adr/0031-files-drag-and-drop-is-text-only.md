# ADR-0031: Drag & drop into FILES is text-only, and batched

**Status:** Accepted (DEV-2500, subtask of DEV-2498)

> Numbered 0031, not 0030: DEV-2499 (the blank starter templates) takes 0030 on
> its own branch and merges first.

## Context

The FILES section could only gain a file through its `+` control and a typed
path. Marek asked for drag & drop — single and multiple files, with a visible
drop target.

The awkward part is not the drag plumbing, it is what a dropped file *is*. A
workspace is `Record<string, string>` from the editor down to the builder:
`pipeline/import.mjs` refuses binaries outright (`BINARY_EXT` records the path
and drops the bytes), `POST /api/session/:id/file` takes `{ path, contents }` as
text, and the R2 snapshot is written from that same string map. There is no
representation for an image today, and "drop a file in" will read to anyone as
"drop my logo in".

## Decision

**1. Text only, refused by name, with the reason shown.** An allowlist of
extensions (plus a few extensionless text names), a 512 KB per-file cap matching
the importer's `MAX_TEXT_BYTES`, and a 50-file ceiling per drop. A refused file
produces a line under the FILES header — "Skipped logo.png (not a text file)" —
rather than silence or a corrupted file in the editor. Build output, `.git`,
`node_modules` and lockfiles inside a dropped directory are skipped without
comment: nobody meant to drop those, so there is nothing to report.

Image and font support is deliberately **not** in this change. It needs either
base64 in the `FilesMap` or an R2 asset side-channel through the builder, and
both are larger than this ticket.

**2. `.env` files are never accepted**, whatever their suffix. A demo is a
shareable artifact; a dropped `.env.local` would put real credentials one Save
away from a public `/d/:id`.

**3. One batched callback, `onAddFiles`, not `onAddFile` in a loop.** N separate
adds are N workspace commits, and on a Tier-2 framework N dev-server rebuilds,
each invalidating the last. The tree hands the whole drop over in one call.

**4. A collision waits for an answer, and the whole batch waits with it.**
Replace / Keep both / Cancel, with focus on Keep both — the files a replace would
overwrite may hold unsaved edits and nothing in the app can undo that. Applying
the non-colliding half immediately would leave a state nobody can reason about
afterwards.

**5. The drop target is styled from the app stylesheet, keyed off
`data-dropping`** (and `data-drop-target` on the row a drop would land in), per
ADR-0026: an inline `outline`/`background` on the section would outrank the row
rules and the target would never light up.

**6. Gated on the same switch as the rest of the file CRUD** (`editable` plus the
presence of the callback), so `/share/:id` and anonymous play have no drop target
at all.

## Consequences

- `packages/editor-shell/src/dropFiles.ts` holds the traversal and stays free of
  React and DOM types, so `pipeline/drop-files.test.mjs` drives it with fakes.
  That is where the cases a Playwright drop cannot reach live: nested
  directories, excluded trees, and the `readEntries` batching contract (the real
  reader returns ~100 entries per call and an empty array to finish — a
  single-call implementation silently truncates a large folder).
- A scripted `DataTransfer` returns `null` from `webkitGetAsEntry()`, so
  `e2e/files-drop.spec.ts` exercises the plain-`files` fallback rather than the
  entry traversal. Both paths exist for that reason, not only for old browsers.
- The 50-file ceiling and every per-file refusal are reported. A silent cap would
  read as "everything was added".

## Amendment — archives are unpacked (DEV-2531)

**Status:** accepted, 2026-08-14.

One binary is now accepted at the drop: a `.zip`. It is still never *stored* — it is
expanded in the browser and discarded, and every entry then faces exactly the rules
above. So the decision this ADR records is unchanged (a workspace is text), while the
route into it is no longer "unzip it yourself first".

Why: the forum case. A user attaches an archive of the project that fails for them,
and the manual unzip was the only step between that and their code running here at
any version. The reverse direction already existed — Download writes a `.zip` of the
workspace with `fflate`, so reading one is `unzipSync` and costs no new dependency.

Three rules exist only for archives, in `dropZip.ts`:

- **A single wrapping directory is stripped.** Archives are `project/…`; landing
  `project/src/index.js` when the user expected `src/index.js` is wrong. Two roots, or
  a file at the root, keep their paths.
- **Traversal is refused, not resolved.** `..` segments, absolute paths, drive letters
  and backslash separators are rejected per entry — a zip is the one input here whose
  paths come from a stranger's filesystem.
- **Nothing is inflated before the caps are consulted.** The expander reads the central
  directory first — names and declared sizes — decides what it will take, and only then
  inflates that subset (`unzipSync`'s `filter`). Deciding afterwards was the first cut,
  and it meant a 1 MB archive of zeros could expand to gigabytes in the tab before any
  limit was reached. The declared size is a claim, so the inflated length is checked
  too. Three ceilings: 512 KB per entry, 4 MB unpacked in total, and 8 MB on the
  archive's own bytes, checked before it is read into memory at all.

`dropZip.ts` takes the accept/exclude rules as an *argument* rather than importing them
from `dropFiles.ts`. Both modules are unit-tested by `pipeline/*.test.mjs`, which runs
the sources through `--experimental-strip-types` and cannot resolve a sibling
`./dropFiles.js` specifier with no build output. The injection is what makes the test
able to pass the real rules — which it does, so "what a drop accepts" and "what an
archive accepts" cannot drift apart.
