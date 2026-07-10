# ADR-0019: Documentation-guide examples in the runner; remove render-ms

**Status:** Accepted

## Context
The runner shipped with the 13 starter templates only. The Handsontable
documentation guides contain ~935 `::: example` instances
(`handsontable/docs/content/guides/**/example*.*`) across four frameworks. We want
each one launchable, editable, and browsable in the runner, grouped by docs-folder
breadcrumb, and openable from a stable URL. Separately, `render-ms` (the old
CodeSandbox-redirect microservice) is no longer needed.

## Decision
1. **Import docs examples.** `pipeline/import-docs.mjs` walks the docs repo, parses
   each `::: example` directive, and wraps every framework fragment into a minimal
   runnable project via `pipeline/wrap-docs-example.mjs` — a Node port of the
   docs site's own `buildProjectFiles` ("Edit on StackBlitz") wrapper, kept in
   lockstep so a docs example runs identically in both places. Output is a
   committed snapshot under `apps/authoring/public/docs-examples/`: a small
   `manifest.json` (drives the grouped picker) + one CatalogEntry JSON per example
   (lazy-fetched on open). Auto-sync from the docs repo is deferred.
2. **Open by URL.** The authoring app honours `?docs=<content-path>` (e.g.
   `?docs=guides/columns/column-adding/react/example1.tsx`), mirroring the existing
   `?example=` starter deep links.
3. **Engine per framework.** JavaScript, TypeScript, and React run on Tier-1
   (Sandpack, in-browser) — verified. Vue and Angular run on Tier-2 (container,
   real dev server): the classic in-browser bundler has no Vue-3 `<script setup>`
   or modern-Angular support, so those need real Vite / `ng serve`. Vue is baked
   into the shared Tier-2 image (`scripts/prepare-container.mjs` `EXTRA_CONTAINER`);
   Angular reuses the existing container.
4. **Remove render-ms.** Delete the `render-ms/` service, the worker compatibility
   shim (`migrate.ts`, `/codesandbox-vm`, `/codesandbox-browser`, `/r/:framework`),
   and their routes. The version-dispatch logic it originated already lives in
   `packages/runtime/version.ts`.

## Consequences
- The runner covers the full documentation example surface, not just starters.
- Docs examples are a versioned snapshot in the repo; regenerate with
  `node pipeline/import-docs.mjs` when the docs change.
- Vue/Angular docs examples require the Tier-2 image to be rebuilt + deployed
  (`prepare-container` → docker build → `wrangler deploy`) to serve; they do not run
  in local dev without the orchestration worker + Docker.
- Old `render-ms` / CodeSandbox-redirect deep links stop resolving (accepted).
