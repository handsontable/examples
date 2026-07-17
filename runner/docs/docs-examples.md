# Documentation-guide examples in the runner

The runner serves every example that appears in the Handsontable documentation
guides — the ~935 `::: example` instances under
`handsontable/docs/content/guides/**/example*.*`, across JavaScript, TypeScript,
React, Vue, and Angular. Each is wrapped into a minimal runnable project, grouped
in the example picker by its docs-folder breadcrumb, and openable from a stable URL.

## Opening an example

```
https://demos.handsontable.com/?docs=<content-path>
```

`<content-path>` is the docs content path of the example's entry file, e.g.

```
/?docs=guides/columns/column-adding/javascript/example1.ts   → TypeScript
/?docs=guides/columns/column-adding/react/example1.tsx        → React
/?docs=guides/columns/column-adding/vue/example1.vue          → Vue 3
/?docs=guides/columns/column-adding/angular/example1.ts       → Angular
```

This mirrors the starter deep link `?example=<framework>`. The picker in the
authoring app lists a **Starter templates** group followed by one `<optgroup>` per
guide breadcrumb (e.g. *Columns ▸ Adding and removing columns*).

If `<content-path>` doesn't resolve to an imported snapshot, the runner shows a
blocking "example not found" screen instead of silently falling back to the
default starter.

## How it is built

Two dependency-free Node scripts, run from `runner/`:

```bash
node pipeline/import-docs.mjs --docs-branch=prod-docs/18.0
node pipeline/import-docs.mjs --docs=/path/to/handsontable/docs --docs-branch=prod-docs/18.0
HOT_DOCS_DIR=/path/to/handsontable/docs node pipeline/import-docs.mjs --docs-branch=develop
```

- `--docs-branch` is required. `prod-docs/<major.minor>` becomes that release
  bucket (for example, `18.0`); `develop` becomes the `next` bucket.
- Release buckets bake the concrete version from the checkout's sibling
  `handsontable/package.json`. The `next` bucket bakes npm's
  `handsontable` `dist-tags.next`; an unavailable or malformed tag is a fatal
  import error.
- **`pipeline/wrap-docs-example.mjs`** — wraps a loose example fragment into a full,
  minimal project per framework. It is a Node port of the docs site's own
  `buildProjectFiles` (the "Edit on StackBlitz" wrapper in
  `handsontable/docs/public/example-tabs.js`), kept in lockstep so an example runs
  identically in StackBlitz and in the runner.
- **`pipeline/import-docs.mjs`** — walks the guides, parses every `::: example`
  directive for its `@[code]` file refs, detects the framework from the folder,
  wraps each runnable variant, and writes a committed snapshot to
  `apps/authoring/public/docs-examples/`:
  - `<bucket>/manifest.json` — metadata only (including the bucket, docs branch,
    and concrete Handsontable version); drives the picker.
  - `<bucket>/<encoded-docsPath>.json` — one full `CatalogEntry` per example,
    lazy-fetched on open.
  - Regenerating a bucket deletes and replaces only that bucket's directory; it
    never deletes another version's snapshot.

The snapshot is **committed** to the repo (the sync mechanism from the docs repo is
a later concern). Regenerate it whenever the docs examples change.

## Engine per framework

| Framework(s) | Engine | Why |
|---|---|---|
| JavaScript, TypeScript, React | Tier-1 Sandpack (in-browser) | Instant, no server; verified rendering. |
| Vue, Angular | Tier-2 container (real dev server) | The classic in-browser bundler cannot compile Vue 3 `<script setup>` or modern Angular; they need real Vite / `ng serve`. |

Vue is baked into the shared Tier-2 image via the `EXTRA_CONTAINER` list in
`scripts/prepare-container.mjs`; Angular reuses the existing container. To serve
Vue/Angular docs examples in production, rebuild + deploy the Tier-2 image:

```bash
node scripts/prepare-container.mjs      # regenerates Dockerfile + frameworks.generated.ts
# then build the containers/live image and `wrangler deploy` the API worker
```

> Tier-2 examples need the orchestration worker (and Docker locally) running; they
> do not render in a bare `apps/authoring` dev server.

## "Show in runner" from the docs (future)

The docs example toolbar (`buildExampleHtml` in
`handsontable/docs/src/plugins/framework-loader.mjs`) already renders "Edit on
StackBlitz" + "See on GitHub" buttons and carries a per-example JSON payload. A
"Show in runner" link is a small addition there — link to:

```
https://demos.handsontable.com/?docs=<the example's content path>
```

Which frameworks get the link, and whether it replaces StackBlitz, is a docs-repo
decision made separately; the runner side is ready today.
