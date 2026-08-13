# ADR-0030: Blank starter templates, synthesized per bucket

**Status:** Accepted (DEV-2499, subtask of DEV-2498)

## Context

Until now, starting a demo from nothing was not possible. "New demo" meant
forking a catalog example — `MyDemos`' Create tile linked to the playground,
whose default is the React showcase — so every fresh demo opened with
`src/constants` sample data, `src/hooksCallbacks` helpers, ten `registerPlugin`
calls, four cell types and Arabic/RTL i18n to delete first. Marek reported it
as the first of three demo-runner asks.

Two questions had to be settled:

1. **Where do the template files come from?** Every starter to date is a real
   directory under `examples/`, collected by `pipeline/import.mjs`.
2. **Is "blank" the new default for a new demo, or one more option?**

## Decision

**1. The blank templates are generated, not committed as example directories.**
`pipeline/blank-starters.mjs` emits the files; `config/frameworks.json` marks
those three frameworks `synthetic: true`, and `collectExample` is bypassed for
them. Everything downstream — Handsontable pinning, lockfile resolution,
manifest rows, `catalog.json` — treats them like any other starter.

The deciding factor is that the emitted code **must differ per bucket**
(ADR-0029, DEV-2200): below 17 the template imports
`handsontable/styles/*.min.css` and names its theme as the `themeName` *string*;
from 17 up core CSS auto-injects and the theme is the `mainTheme` object, which
does not exist below 17. A disk-backed template would therefore have to be
hand-committed to `prod-examples/15` and `prod-examples/16` and kept in sync
with master's variant forever — the exact maintenance the buckets exist to
avoid. Secondarily, `examples/` is the *published* example set; a blank grid is
a runner affordance, not something the website should link to.

**2. Blank is a separate option, listed first — not the new default.**
`?example=react` and every other deep link keeps loading what it always loaded.
What changes is `MyDemos`' Create tile, which now points at `/?example=blank`:
"Create" means starting from nothing, while the playground's own default stays
the showcase. Key order in `frameworks.json` is picker order, so putting the
three blank entries at the top of the file is what puts them at the top of the
list — no picker-model change.

**3. Three templates, all Tier 1.** `blank` (JavaScript), `blank-ts`
(TypeScript), `blank-react` (React + `@handsontable/react-wrapper`), each on the
Sandpack engine its non-blank counterpart uses. A blank grid must never cost a
container boot, so no Tier-2 variant exists.

**4. Minimal means minimal, but the toolchain stays honest.** The entry file
configures `startRows`/`startCols`/`rowHeaders`/`colHeaders`, the bucket's theme
idiom and `licenseKey` — nothing else. It imports the full `handsontable`
bundle rather than `handsontable/base`, so a plugin someone switches on later
actually works without a registration step. Each template still ships a
resolved `pnpm-lock.yaml` (added by the importer, not the generator) and pins
`packageManager: pnpm@10.34.5`, because without a lockfile the snapshot
builder's frozen install fails and falls back to a fresh resolve — a demo saved
a year from now would build against whatever `vite`/`react` resolve to then.

## Consequences

- Changing a template is a code change plus a regeneration. `node
  pipeline/import.mjs --synthetic` regenerates only the synthetic artifacts
  across every bucket on disk, reusing each manifest's pinned version, so it
  costs three small lockfile resolutions instead of a full 16-starter re-import.
  `node scripts/prepare-container.mjs --generated-only` then refreshes
  `BUILD_CONFIG` without touching the committed baked contexts or the Dockerfile.
- The `synthetic` flag is now part of the `frameworks.json` contract. A second
  generated family (a "blank Vue", say) needs a template in
  `blank-starters.mjs` and nothing else.
- `pipeline/blank-starters.test.mjs` guards both properties that matter and
  that nothing else would catch: the file set stays minimal, and each bucket
  gets the right styling idiom. Both failure modes produce a *working build*
  with a broken grid.
- The live-mount gate stays `e2e-starter-matrix.yml`, which enumerates
  `catalog.json` and therefore picks the templates up with no workflow change.
