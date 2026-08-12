# Starter-example backport policy

How the `examples/` starters are developed, snapshotted per Handsontable major,
and repaired after they freeze. Companion to
[ADR-0029](adr/0029-starter-example-buckets-and-frozen-branch-backports.md);
this file is the operational policy, the ADR records why the system is shaped
this way.

## Branch model

- **`master` is the only development branch.** All starter authoring, feature
  work, and best-practice modernization happens here. Master feeds the `next`
  bucket and any major bucket that has no `prod-examples/<major>` branch yet
  (that is how a freshly released major works until its branch is cut).
- **`prod-examples/<major>` (e.g. `prod-examples/15`) are frozen snapshots.**
  One per supported major, holding the `examples/` tree that bucket is
  generated from. They never receive feature work or cosmetic cleanups —
  only cherry-picks per the rules below. Everything outside `examples/` on
  these branches is dead weight: the import workflow sparse-checks-out only
  `examples/**` from the branch and always runs pipeline code from master.
- The `next` bucket is hard-wired to master; a `prod-examples/next` branch
  would be ignored.

## What may land on a frozen branch

Cherry-picks only, and only these classes:

1. **Compatibility fixes** — the starter no longer boots/builds at that
   bucket's pinned Handsontable or against current tooling.
2. **Build/infra fixes** — package-manager, lockfile, or scaffold breakage
   (e.g. a registry change, a peer-dependency ceiling).
3. **Security fixes** — vulnerable dependency pins.

Not eligible: new features, cosmetic refactors, best-practice modernization
(those describe what master is for). The canonical example: DEV-2200's
CSS-import removal is **wrong** for `prod-examples/15|16` — below 17.0.0
core CSS does not auto-inject and `handsontable/themes` does not exist, so
those branches keep `handsontable/styles/*.css` imports and the string
`themeName` form permanently.

Apply eligible fixes **newest → oldest** (18 → 17 → 16 → 15), stopping at the
oldest major where the fix is still relevant.

## Keep repairs dependency-minimal

The container image bakes **one** node_modules seed per framework (bucket 18;
ADR-0029 / PR #146). Every other bucket's pristine session runs a frozen
install that reconciles against that seed — today the delta is only the
Handsontable core/wrapper pins (~2–3 packages, ~1.3 s). Every dependency a
frozen branch changes away from master (a reverted framework major, an extra
package) grows the boot-time download for that bucket's sessions. Frozen
install stays correct regardless — it degrades gracefully — but prefer
source-level fixes over dependency changes, and record anything heavy here:

| Branch | Divergent deps beyond the HOT pins | Boot-delta note |
|---|---|---|
| `prod-examples/15` | none yet | — |
| `prod-examples/16` | none yet | — |
| `prod-examples/17` | none yet | — |
| `prod-examples/18` | none yet | — |

## Never hand-pin Handsontable dependencies

Branch sources keep `"handsontable": "latest"` (and wrapper `"latest"`). The
pipeline pins core + every `*handsontable*` dependency (except
`@handsontable/pikaday`) to the bucket's resolved version and regenerates the
lockfile at import time. A hand-pinned version in branch source would be
silently overwritten — it only misleads readers.

## Regeneration and drift detection

- A push touching `examples/**` on master **or** any `prod-examples/**`
  branch auto-triggers `.github/workflows/import-starters.yml`, which
  regenerates the affected buckets and opens/updates the
  `chore/starter-example-buckets` PR against master. Review that PR's diff —
  after the branches were proven byte-stable, any diff is genuine content.
- Manual per-bucket dispatch:
  `gh workflow run import-starters.yml -f bucket=15`.
- The weekly run (Mon 06:00 UTC) re-resolves each bucket's `hotVersion`, so
  patch releases re-pin automatically.
- The e2e starter matrix
  (`gh workflow run e2e-starter-matrix.yml`, single job, `--workers=2`,
  never parallelized — prod caps live previews at 5 concurrent globally)
  boots every starter × major against prod and is the drift alarm for
  content that regenerated but no longer works.

## When a new major ships

1. npm `dist-tags.latest` bumps → the workflow's bucket list grows by itself;
   the new major's bucket generates from master (no branch yet).
2. Modernize master for the new major; the new bucket absorbs it on every
   re-import while branch-less.
3. When master starts moving past what the released major should ship (or the
   next major's work begins), cut `prod-examples/<major>` from master —
   snapshot is born current, no initial cherry-pick round.
4. Update `frameworks-generated.test.mjs`'s expectations if the bucket count
   changes (`checked >= 40` tripwire) — regenerate via
   `node pipeline/import.mjs` + `node scripts/prepare-container.mjs`.
