# ADR-0024: Icon system — tabler-icons as a dependency, seti-ui generated from source

**Status:** Accepted

## Context
The DEV-2027 redesign needs icons in the chrome (T2), the sidebar (T3) and the tab strip (T4).
Figma sticky `11:2545` fixes the two families: **tabler-icons** for UI, **seti-ui** for file
types, with the seti sheet pasted wholesale into node `11:2471`. Before T1 the repo had no icon
system: one hand-inlined tabler sun/moon pair in `ThemeToggle.tsx`, two logo `.svg` assets
consumed as `<img src>`, and unicode glyphs (`✎ ✕ + ↗ ▾ ▸ ✓`) standing in elsewhere.

The two families differ in kind. tabler ships a maintained React package; seti-ui is an Atom/VS
Code theme with no React distribution — its icons live as `.svg` files and its
extension→icon→colour mapping lives in LESS.

## Decision

**tabler-icons is a dependency.** `@tabler/icons-react` in `editor-shell`'s `dependencies`,
re-exported through `src/icons/ui.tsx` under stable local names. The wrapper pins the design's
16px/2px rendering (tabler defaults to 24px) and marks icons `aria-hidden` — labels belong on
the enclosing button. Twenty icons; every one but `sun`/`moon` and the two toggled counterparts
(`layout-sidebar-left-collapse`, `chevron-right`) was read off a Figma layer name. Sun and moon
appear in **no** frame — they come from T0 and are not to be "corrected" against the design.

No Vite config was needed. The package resolves through a ~7MB bundled ESM entry (per-icon
modules exist alongside it), which looked like it would need `optimizeDeps.include` — but Vite's
scanner crawls the aliased shell source, finds the bare import and pre-bundles it on the first
cold run by itself. Measured on a cleared `node_modules/.vite`: 741ms to first paint of the theme
toggle with no config, 1029ms with an `include` entry, no full-reload notice either way. The
explicit entry also has to be spelled `"@handsontable/demo-editor-shell > @tabler/icons-react"`,
since the app's own `node_modules` can't reach a dependency of the shell. Left out — it was
slower, more config, and load-bearing on a pnpm layout detail. Production is unaffected either
way; the package is `sideEffects: false`.

**seti-ui is generated from source at a pinned commit.** `scripts/sync-seti-icons.mjs` reads
`mapping.less`, `ui-variables.less` and the needed `icons/*.svg` from a pinned SHA and emits
`src/icons/generated/seti.ts`. Committed output; CI installs `--frozen-lockfile` and never runs
the generator.

- **The mapping is the colour source of truth, not each SVG's baked `fill`.** They disagree
  upstream (`typescript.svg` bakes `#529BBA` where `@blue` is `#519aba`; `yml.svg` bakes
  `#9F74B3` where `@purple` is `#a074c4`), and the mapping is what seti's own editor uses.
  Geometry is emitted with `fill="currentColor"` and coloured through CSS `color`, so one code
  path covers selection and muted states. `folder` is the single exception — it has no mapping
  entry, so it borrows its own fill.
- **Both of upstream's match kinds are kept.** `.icon-set` keys become exact-name or
  suffix lookups; `.icon-partial` keys stay substring matches, checked between the two. That
  ordering is load-bearing: a starter or a user's own demo may contain `LICENSE.txt`, and `.txt`
  is a curated suffix, so exact-only matching would draw it with the generic `default` glyph.
- **Coverage is curated** to file types the runner can contain: 38 suffixes, 5 exact filenames,
  1 substring rule, 29 icons, ~22KB. `catalog.json`'s 124 example filenames use 17 extensions; the starters add
  angular/astro/nuxt shapes. Nothing in the runner produces `bsl` or `coldfusion`.
- **The generator fails rather than degrades.** Every curated key must resolve against
  `mapping.less`; every icon must have geometry; no `transform`, no non-`<path>` geometry, at
  most one distinct fill. It also replays the runtime resolver over 15 fixtures, which is what
  gates "unknown extension falls back to a generic icon" — `editor-shell` has no build step and
  the repo has no DOM test runner, so `tsc --noEmit` plus these assertions are T1's whole gate.

**Colour-literal rule.** The generated palette is a third documented exception to "only
`theme.ts` may hold a colour literal" (ADR-0028), alongside the logo SVGs and the pre-paint
background. These are upstream brand values, identical in light and dark — frames `48:6560` and
`31:6438` show the same colours in both modes.

**One import surface.** Everything is re-exported from the package barrel `src/index.ts`.
`editor-shell/package.json` has `main` only, and both consumers alias the bare specifier
straight at the barrel (`apps/authoring/vite.config.ts`, `apps/authoring/tsconfig.json`), so
`@handsontable/demo-editor-shell/icons` would not resolve.

## Consequences
- T2–T4 have one place to import from, and file-type resolution is shared between the tree and
  the tab strip.
- Adding a file type is one line in the script's curated list plus a re-run.
- Upstream tabler updates arrive with a version bump; upstream seti updates require bumping
  `SETI_SHA` and reviewing the generated diff.
- Upstream colours are upstream's judgement, including where that reads oddly here: `.gitignore`
  maps to `@ignore` `#41535b`, which sits near-invisible on the dark sidebar (`#000000`). seti
  means it as "this file is ignored"; a demo's `.gitignore` isn't. `<FileIcon color>` exists for
  exactly this kind of per-surface override if T3 wants one.
- Two-colour seti icons (`zip`, `pdf`, `mp4`) cannot be flattened to `currentColor` and are
  excluded. Those file types don't occur in demos; if one ever must be shown, the generator
  fails loudly rather than drawing a broken glyph.
- The unicode glyphs still in `FileTree.tsx`, `App.tsx`, `DocsCascader.tsx`, `MyDemos.tsx` and
  `ShareLinks.tsx` are deliberately untouched — swapping them is T2/T3/T4 restyle work.
