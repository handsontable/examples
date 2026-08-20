// The state commit of a drag & drop (DEV-2500), as a pure map transform.
//
// Extracted from `App.tsx`'s `addFiles` so the batching requirement stops being
// a code comment and becomes an importable contract: the ticket calls the
// batched `onAddFiles` necessary, not cosmetic — N sequential `addFile` calls
// would mean N `setFiles` renders and, on a Tier-2 framework, N container
// pushes each invalidating the last. `pipeline/add-files.test.mjs` pins the
// shape down; `App.tsx` keeps the side effects (the ref commit, the render,
// the dirty dots, the runtime writes) and delegates the map math here.
//
// Dependency-free on purpose, like `demoOwners.ts` and `markdownActions.ts`:
// a module the pipeline tests load cannot import a sibling `./x.js` under
// `--experimental-strip-types`. The one import is type-only, which the
// stripper erases.

import type { FilesMap } from "@handsontable/demo-runtime";

/** A dropped file, in the shape the FILES tree hands over (`onAddFiles`). */
export interface DroppedWorkspaceFile {
  path: string;
  contents: string;
}

/**
 * Fold one dropped batch into the workspace, in one step.
 *
 * This is DEV-2500's batching contract, and `pipeline/add-files.test.mjs`
 * holds it to exactly this:
 *
 * - A non-empty drop returns ONE new map — never the input mutated — carrying
 *   every existing file plus every dropped one. That single object is what
 *   `App.tsx` commits (one `filesRef` assignment, one `setFiles`), so the
 *   whole drop is one render and one rebuild.
 * - A colliding path is overwritten in place. The FILES tree has already
 *   asked ("Overwrite" vs "Keep both") before the batch gets here, and
 *   "Keep both" renames before the call — a collision arriving here *means*
 *   overwrite.
 * - An empty drop returns `current` itself (reference-equal), so the caller
 *   can compare and skip the commit entirely.
 */
export function applyDroppedFiles(
  current: FilesMap,
  dropped: DroppedWorkspaceFile[],
): FilesMap {
  if (!dropped.length) return current;
  const next: FilesMap = { ...current };
  for (const { path, contents } of dropped) next[path] = contents;
  return next;
}
