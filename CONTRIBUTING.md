# Contributing to handsontable/examples

Thanks for wanting to add or improve an example.

## Adding a new example

1. Create `examples/<name>/` (or `server-examples/<name>/`) as a self-contained
   project: its own `package.json`, its own lockfile, its own README describing
   what it shows. Use an existing example's README as the template rather than
   starting from scratch, e.g. [`examples/react/README.md`](./examples/react/README.md).
2. Give it a `build` script and commit a `pnpm-lock.yaml`.
   [`.github/workflows/examples-build.yml`](./.github/workflows/examples-build.yml)
   discovers example folders at CI runtime by scanning for exactly that
   combination. No workflow file needs editing to get build coverage.
3. Add a row for it to the relevant table in [README.md](./README.md).

### Register it with the live demo runner (easy to miss)

A new `examples/<name>/` folder does **not** automatically show up on
[demos.handsontable.com](https://demos.handsontable.com). The demo runner only
imports frameworks that have a matching key in
[`runner/config/frameworks.json`](./runner/config/frameworks.json).
`runner/pipeline/import.mjs` reads that file's keys, not the `examples/`
directory. Miss this step and the folder still builds fine in CI, but stays
invisible on the live demo site: no error, it just never appears.

- Add an entry for your example to `runner/config/frameworks.json` (tier,
  engine/container, entry file, dev/build commands, etc.), copying the shape
  of a similar existing entry.
- If it's a Tier-2 (container-based, e.g. meta-framework) example, also
  regenerate the container assets: `node runner/scripts/prepare-container.mjs`.
- The demo catalog then regenerates automatically the next time a push to
  `master` touches `examples/**`
  ([`.github/workflows/import-starters.yml`](./.github/workflows/import-starters.yml)
  opens a `chore/starter-example-buckets` PR), or you can run it locally from
  `runner/`: `node pipeline/import.mjs`.

## Updating an existing example

Same rules apply: keep it self-contained, keep its README accurate, and
re-run `node pipeline/import.mjs` (or push to `master`) if you changed anything
the runner reads from `frameworks.json`.

## Pull requests

Fill in `.github/PULL_REQUEST_TEMPLATE.md` when you open the PR, in particular
the `frameworks.json` checklist item; that's the step people forget.
