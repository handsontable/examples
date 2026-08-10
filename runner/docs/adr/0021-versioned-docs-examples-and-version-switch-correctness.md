# ADR-0021: Versioned docs-example snapshots and version-switch correctness

**Status:** Accepted

## Context
ADR-0019 committed docs/recipe examples as a single flat snapshot, regenerated
by wiping and rewriting `apps/authoring/public/docs-examples/` in place
(`pipeline/import-docs.mjs`). This has two consequences that only surface once
Handsontable ships a new major/minor:

1. **Content version is conflated with package version.** `version.ts`
   already re-pins the `handsontable`/wrapper dependency at runtime for any
   selected major (15-19, per ADR-0005). But the docs-example *content*
   (the actual guide code) is only ever the single generation last imported.
   Reimporting for a new release destroys the previous snapshot: an old doc
   page's "Open in runner" link would serve new-API code while the package is
   pinned to the old version — broken by construction, not by bug.
2. **Starters have no equivalent source to snapshot from.** Docs examples are
   copied verbatim from historical guide markdown, so per-version snapshots
   are mechanical. Starters are one hand-maintained scaffold per framework,
   written against the current wrapper API; there is no historical scaffold
   to fall back to below major 15 (`ADR-0005`: pre-15 used different wrapper
   package names). Compatibility across the in-scope 15-19 range is assumed,
   never verified.

Investigation while scoping this work also surfaced:
- The docs repo (`handsontable/docs`, inside the `handsontable` monorepo) cuts
  a `prod-docs/<major.minor>` branch per release (`17.0`, `17.1`, `18.0`
  exist; nothing older). `develop` tracks the next unreleased version and
  corresponds to npm's `dist-tags.next`.
- `pipeline/wrap-docs-example.mjs` bakes a CDN CSS `<link>`
  (`unpkg.com/handsontable@<version>/dist/handsontable.full.min.css`) into
  every wrapped project's `index.html`. `applyHandsontableVersion` re-pins
  only `package.json` — the CSS link never moves, so a version switch within
  the fully-supported 15-19 range still serves mismatched JS/CSS.
- The runner's own tooling (`framework-loader.mjs`, Angular scaffold pinned to
  `@angular/core@21.x`) is verified against the *current* docs branch only.
  Wrapping an old branch's content (e.g. `prod-docs/17.0`, which predates
  `framework-loader.mjs`) with today's wrapper is untested and not assumed
  to work.
- Client-side caching (`docs-catalog.ts`: a singleton `manifestPromise`, an
  `entryCache` keyed by `docsPath` alone) has no version dimension at all.
- A flat per-version snapshot layout does not scale indefinitely: today's
  single generation is ~1452 files / 11MB; Cloudflare Workers static assets
  cap at 20k files, giving a ceiling of roughly a dozen buckets before this
  layout needs to move to R2-backed artifact storage instead of committed
  files.

## Decision

1. **Bucket key = docs branch name, normalized**, not the full semver
   `readHotVersion()` returns: `17.0`, `18.0`, etc.; `develop` maps to the
   literal bucket name `next` (not derived from `develop`'s own
   `package.json` version, which is unreliable pre-release). The concrete
   version baked into that bucket's wrapped `package.json` and CDN CSS URL
   (see #7) is `dist-tags.next` fetched from the npm registry at import
   time — not read from `develop`'s own `package.json`. Missing/unfetchable
   `dist-tags.next` is a fatal CI error for that bucket, consistent with #4's
   fatal-fallback stance.

2. **Version → bucket resolution, exact ordered algorithm**:
   1. Selected version equals npm `dist-tags.next` → `next` bucket.
   2. Else truncate to `major.minor`, exact match against existing bucket
      keys → that bucket.
   3. Else → no bucket. This is the **normal, steady-state** outcome for
      every version in the launch scope's gap (e.g. any `17.x`, per #3's
      two-bucket launch) — the branch may well exist, the bucket was simply
      never imported. Docs-examples are hidden for that version (#9) / a
      deep link resolves not-found. This is *not* the anomaly case.

   There is no content fallback to `next` for an unmatched version, ever —
   silently serving newer bucket content pinned to an older selected version
   reintroduces the exact mismatch this ADR exists to kill, just by rule
   instead of by bug. (An earlier draft of this decision suggested such a
   fallback for "a published `major.minor` with no matching branch" — that
   scenario is now understood to be the ordinary case under #3's forward-only
   scope, not a rare anomaly, so the fallback is removed. A *branch that
   exists but was never imported* is likewise "no bucket," full stop.)

3. **Launch scope: two buckets only — current release and `next`.** No
   backfill to historical branches (`17.0`, `17.1`) at launch, sidestepping
   the untested-old-wrapper problem entirely: tooling always wraps
   same-branch content. Growth is forward-only — each new release adds its
   bucket using whatever wrapper is current at that time. Historical
   backfill remains possible later but is gated on verifying
   `framework-loader.mjs`/Angular-scaffold compatibility against each old
   branch first.

4. **Import pipeline runs in CI**, not by hand: a `workflow_dispatch` GitHub
   Actions workflow, shaped so a future `repository_dispatch` from
   `handsontable/docs` can trigger it automatically without rework. It sparse
   checks out both `docs/content/**` and `handsontable/package.json` per
   branch (the version read needs both); a fallback-to-latest version read
   is a fatal CI error, not silent. The importer's existing exit-1 +
   per-branch counts are surfaced in the job output.

5. **Output layout is scoped per bucket**: writing/regenerating one bucket
   wipes only that bucket's subtree, never the whole `docs-examples/`
   directory. Manifest entries carry their bucket explicitly.

6. **Version-switch semantics for an open docs example**: unedited (per the
   existing `dirty` flag) → reload content from the newly-selected version's
   bucket, replacing files wholesale, since content genuinely differs across
   buckets. Edited → keep current files, re-pin the package version as
   today, and surface a warning that content may not match the new version's
   API. Starters (no `docsPath`) are unaffected: always re-pin only, there is
   no bucket content to reload.

7. **CSS follows the package pin.** Add `applyHandsontableCss(files,
   version)` alongside `applyHandsontableVersion`, rewriting the baked
   `unpkg.com/handsontable@<version>/...css` reference in `index.html` (or
   `src/index.html`) wherever it appears. Called at all three existing
   `applyHandsontableVersion` sites: `container.ts:92`, `sandpack.ts:131`,
   and `App.tsx:301` (the editor's own version-switch effect, which feeds
   shares and exports — skipping it would leave the live preview correct
   while shared/exported demos carry a stale CSS `<link>`). No-ops
   for `pkg.pr.new` builds, which were never published to unpkg (a separate,
   already-accepted limitation).

8. **Client caches become bucket-aware.** `docs-catalog.ts`'s manifest fetch
   becomes keyed per bucket (a map, not a singleton); `entryCache` keys
   become `` `${bucket}:${docsPath}` `` instead of `docsPath` alone.
   Version-dropdown-driven deep links (`?docs=...&v=...`) already emit `v`;
   this decision only fixes the caching layer that reads it.

9. **Picker filtering**: the left-panel example picker hides docs-examples
   for any selected version with no corresponding bucket, showing starters
   only. Simpler than an earlier "floor version" rule, and correct under the
   two-bucket launch scope from #3.

10. **Starter version support stays unrestricted (15-19) for now.** No
    scaffold is disabled preemptively. A separate empirical pass boots each
    starter at each in-range major and records actual breakage; remediation
    (if any) is decided from real results, not assumption. That pass also
    resolves whether `packages/runtime/src/version.ts` needs its own
    minimum-major guard — today only the UI-facing `/api/versions` listing
    enforces the 15 floor (`workers/api/src/index.ts`); a direct
    session/API call bypassing the dropdown could still request an
    out-of-scope major.

11. **Growth ceiling is accepted, not solved, and documented as such.** At
    roughly a dozen buckets the committed flat-file layout approaches
    Cloudflare Workers' 20k static-asset-file cap. R2-backed artifact storage
    is the intended escape hatch; this decision's file-based layout is
    explicitly provisional and must not be designed in a way that blocks
    moving to R2 later (e.g. bucket keys and resolution stay path-shaped
    strings, not assumptions baked into the static-asset pipeline).

12. **Non-Handsontable dependency drift is resolved at import time, not
    accepted.** `import-docs.mjs`'s `collectExtraDeps` currently pins every
    non-builtin import (e.g. a charting library used in one example) to the
    literal string `"latest"` in the wrapped `package.json`. Combined with
    #3's forward-only, effectively-immortal buckets, an unpinned `"latest"`
    means an `18.0` bucket's install can start failing or behaving
    differently years after that bucket was generated, with zero change to
    this repo. Fix: resolve each extra dependency to a concrete version from
    the npm registry at import time and pin that, same freeze guarantee as
    the Handsontable version itself.

## Consequences
- Old docs pages keep working after a new Handsontable release: their bucket
  is untouched by future reimports.
- Two buckets at launch (current + next) means most of the historical
  Handsontable version range (15.x-17.x) has no docs-example coverage yet by
  design — only starters are offered for those versions. This is a scoping
  choice, not an oversight, and is reversible per-branch once the old-wrapper
  compatibility question is answered. Concretely: a docs deep link for a
  version outside the launch scope hits the blocking not-found screen
  (`7712204`), same as any other unresolved `?docs=` link — not a special
  case, the existing gate already covers it.
- A deep link with no `?v=` defaults to the latest bucket (current release),
  same as the version dropdown's own default.
- CI, not a developer's machine, owns docs-repo checkout and regeneration
  going forward; the manual `node pipeline/import-docs.mjs` workflow from
  ADR-0019 is superseded for docs examples (starters still use the separate,
  unversioned `pipeline/import.mjs`).
- The committed-snapshot layout has a known numeric ceiling; revisiting
  storage (R2) is expected within the life of this feature, not hypothetical.

## Superseded in part: decision 7 (CSS follows the package pin) — DEV-2207

The baked `<link>` is gone. `pipeline/wrap-docs-example.mjs` no longer emits any
Handsontable stylesheet, because from **17.0.0** core injects
`<style id="handsontable-core-styles">` itself and applies `mainTheme` whenever
`theme` is undefined — browser-probed at 17.0.0 and 18.0.0 with zero CSS loaded:
`ht-theme-main` on the root wrapper, `--ht-line-height` resolving, borders and
header background painted, and an example's own `.override-theme` block still
winning. The URL this ADR recorded, `dist/handsontable.full.min.css`, was removed
from the package at that same 17.0.0, so every artifact generated under decision 7
was requesting a 404. Emitting `styles/handsontable.min.css` instead would not
have helped: redundant at >=17 (a `<link>` never suppresses `#injectCoreStyles`,
which only checks for an existing `<style>` with that id) and with nothing to
attach to below 17, where no `ht-theme-*` class is applied at all.

`applyHandsontableCss` survives as a **migration shim only**, since saved demos
replay their files verbatim from R2: it strips the legacy link at >=17 and for
`-next` builds, and rewrites just the version segment at <=16, where the legacy
file is still published and is the only stylesheet that styles a class-less grid.
Fresh artifacts have no link, so it is a no-op on them.

Decision 6 (version-switch semantics) and the rest of this ADR stand unchanged.
