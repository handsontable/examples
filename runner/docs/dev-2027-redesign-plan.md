# DEV-2027 — Demo runner UI/UX redesign — subtask breakdown

Task: [DEV-2027](https://app.clickup.com/t/86camqwaw)
Design: [Figma Sandbox / section `18.1`](https://www.figma.com/design/KCl2Csh9WUSwCrddffnYuD/Sandbox?node-id=72-18175) (fileKey `KCl2Csh9WUSwCrddffnYuD`)
Repo: `handsontable/examples` → `runner/packages/editor-shell/src/` + `runner/apps/authoring/src/`
Decisions: [ADR-0022](adr/0022-shell-theming-via-css-custom-properties.md) (theming),
[ADR-0023](adr/0023-redesign-scope-and-shipping.md) (scope rules, deferred gaps, shipping)

## Ground rules for this redesign

1. **Feature exists but isn't in the design** → keep it, restyle it to the design system.
   Never delete working functionality because a frame omits it.
2. **Design introduces something new** → decide per item: build now, or split into its own
   feature task. Each new element below carries that call explicitly.
3. **Branching.** One integration branch `feat/DEV-2027-redesign` off `master`. Every subtask
   is its own branch off it, PR'd *into* it — small reviewable PRs, one production deploy at
   the end. Deploy is manual (no CI), so a single deploy is the point.

## Frame index

| Node | Name | What it shows |
|---|---|---|
| `48:6560` | Light mode / Light example | Baseline fork/edit view, light chrome |
| `31:6438` | Fork preview — Dark mode / Dark example / Show Files Sidebar | Dark chrome, sidebar with nested `src/` folder |
| `65:21451` | Light mode / Dark example | **Mixed**: light chrome + dark grid |
| `65:19433` | Dark mode / Dark, system example / Default view | Sidebar collapsed |
| `72:15697` | Example (before login) | Full toolbar: version + framework selectors, panel toggles, Sign in |
| `72:14610` | Example (before login, booting) | Loading state — spinner + "Loading data …" |
| `72:26445` | Example Refreash | Preview refresh in flight |
| `72:17078` | Search | Example-picker cascader popover |
| `65:20432` | Mode Full | Preview-only mode |
| `72:11913` | Mode Embed Docs | Bare grid, light, no chrome |
| `72:13670` | Mode Embed Docs | Bare grid, **dark**, no chrome |
| `85:9970`, `85:16935` | Resize | Splitter drag state (light + dark) |
| `11:2471` | icons | seti-ui file-type icon sheet |
| `65:24280` | Mode Full | *not rendered — name-inferred pair of `65:20432`* |
| `65:17596` | Fork preview — Dark mode / Light example | *not rendered — name-inferred* |

Sticky notes (decisions baked into the design):
- `11:2535` — code colors = same as docs, GitHub Theme Dark/Light
- `11:2545` — icons = tabler-icons + seti-ui (file icons)
- `72:16829` — book icon → docs page, github icon → example repo
- `72:14527` — embed iframe: `body { margin: 0 }` → **out of scope**, `/embed/:id` dropped (T8)
- `72:14532` — no rename / delete / add file in the sidebar in fork/view mode
  → **conflicts with ground rule 1** (that CRUD exists and works). See T3.

Row-2 icon inventory, read from `72:15697`'s layer names (settles what the icons actually are):
`tabler-icon-layout-sidebar-left-expand` (sidebar toggle) · `tabler-icon-x` (tab close) ·
`tabler-icon-search` (in the centre pill) · `tabler-icon-refresh` (preview) ·
version pill + `chevron-down` · `tabler-icon-brand-react-native` + `chevron-down` (framework) ·
`tabler-icon-book` (docs) · `tabler-icon-brand-github` (repo) · `tabler-icon-window-maximize`.
**There are no editor/preview panel-toggle buttons in the design.**

## Gap summary — why this is not a repaint

`theme.ts` is a single frozen light palette. `styles.ts` exports a module-level
`const s = {...}` computed at import time from it — it **structurally cannot** do dark mode.
Everything visual downstream depends on replacing that first.

---

## T0 — Theming foundation: dual-mode tokens (BLOCKING)

**Scope.** Rewrite `theme.ts` as a two-mode token set (light/dark) emitted as CSS custom
properties on a root element; convert `styles.ts` from a frozen object to variable-driven
styles. Theme toggle in the top bar (sun/moon), persisted to `localStorage`, defaulting to
`prefers-color-scheme`. CodeMirror theme swapped to GitHub Dark/Light to match docs.

The toggle drives the **whole authoring app** — chrome and all app surfaces.

**Embed:** the app appends a *preferred* theme to the embed URL it hands out — built at
`apps/authoring/src/App.tsx:811` and surfaced through `ShareDialog.tsx`. Those two files are
the whole of it. How the embed acts on that hint is **out of scope for DEV-2027**.

**Measured ramp** — sampled pixel-by-pixel out of the frames, not inferred from the variable
list. Only the dark frame separates the steps; light collapses onto `#ffffff` / `#f7f7f9`.
Downstream subtasks should assign from this table rather than re-deriving it:

| token | light | dark | surfaces (per `48:6560` / `31:6438`) |
|---|---|---|---|
| `surfaceSunken` | `#f7f7f9` | `#000000` | left sidebar |
| `surface` | `#ffffff` | `#070604` | row-2 bar, tab strip, preview surround |
| `surfaceMuted` | `#f7f7f9` | `#19191c` | editor pane, both status bars |
| `surfaceRaised` | `#ffffff` | `#222222` | top bar, popovers, dialogs, drawers |

`border` `#e7e7e9`/`#222222` · `text` `#262624`/`#d1d1d4` · `accent` `#1A42E8` in both modes.
`theme.shadow.*` covers `sm` / `popover` / `dialog` / `panel`. `color-scheme` is emitted per mode,
so native scrollbars and `<select>` popups follow the shell — no token can reach those.

**Files.** `theme.ts`, `styles.ts`, `CodeEditor.tsx`, root of `App.tsx`; touches every shell component.
**Nodes.** `48:6560`, `31:6438`, `65:21451`.
**Acceptance.** Toggle flips every app surface with no flash on load; no hard-coded hex outside
`theme.ts`; both packages typecheck.
**Blocks.** T2–T8.

> Note on the example's own theme: the running example imports its own
> `ht-theme-main.min.css` inside the iframe, so the shell cannot restyle it. Mixed frames like
> `65:21451` (light chrome + dark grid) are that, not a second toggle. Nothing to build.

---

## T1 — Icon system (BLOCKING for T2/T3/T4)

**Scope.** One shared icon layer. tabler-icons for UI (chevron, refresh, download,
external-link, search, panel toggles, sun/moon, book, github) + seti-ui file-type icons mapped
by extension (~150 in `11:2471`). Decide inline-SVG components vs a package dependency.

**Files.** new `packages/editor-shell/src/icons/`.
**Nodes.** `11:2471`, sticky `11:2545`.
**Acceptance.** Single import surface; unknown extension falls back to a generic icon.

**Shipped (DEV-2155, ADR-0024).** `@tabler/icons-react` as a dependency, re-exported through
`src/icons/ui.tsx` with the design's 16px/2px defaults pinned; seti-ui generated from a pinned
commit by `scripts/sync-seti-icons.mjs` into `src/icons/generated/seti.ts` (29 icons, 38 suffixes,
6 exact filenames). `<FileIcon path="…" />` + `<FolderIcon />` + `resolveFileIcon()`, all
re-exported from the package barrel. Colour comes from seti's `mapping.less`, not each SVG's baked
fill — see open item 4.

---

## T2 — App chrome: top bar + secondary bar

**Scope.** Two-row chrome.
Row 1: logo · centered example pill (HOT icon + search affordance) · theme toggle ·
`Download` (authed) / `Sign in` (anon).
Row 2: sidebar toggle · file tabs · divider · preview refresh · URL bar · version selector ·
framework selector · book (docs) · github (repo) · window-maximize.

**No panel toggles.** Confirmed from layer names — the three right-hand icons are `book`,
`brand-github` and `window-maximize`, not show/hide-pane buttons.

**Framework selector — restyle, not a feature.** It already exists as a button group
(`apps/authoring/src/App.tsx:881-899`, `currentFrameworks` + `FW_LABEL`), rendered only when
the current example has framework variants — i.e. docs examples. Starter templates have no
variants and correctly show nothing; they're picked through the example cascader instead.
This subtask converts that button row into the design's `React ▾` dropdown and keeps the same
show/hide rule.

**Docs / GitHub links — restyle, not a feature.** `See in documentation ↗` /
`See on GitHub ↗` already exist (`App.tsx:900-923`); sticky `72:16829` is just their icon form.

*New in this subtask:* the centered example pill, the preview URL bar, `window-maximize`.
All small — **build now**.

### Authed action bar (new — not in any frame)

Six working affordances appear in no frame: `Save` + `Share` (`mode="edit"`), `Embed` +
`Fork this demo` (`mode="play"`) — all `Toolbar.tsx:93-132` — the custom-version input
(`Toolbar.tsx:73-87`) and the `My demos` toggle (`App.tsx:924`). All six are signed-in-only.

**Resolution:** they get their own bar in the **right panel, above the preview**, rendered only
when signed in. Anonymous visitors see exactly the chrome the design shows — the two designed
rows, unchanged. The extra bar is additive and invisible to the audience the frames depict.

Styled to the T0 token set; layout to dev judgment within that column.

**Files.** `Toolbar.tsx` (rewrite), `EditorShell.tsx`, `App.tsx` (top-bar region), `styles.ts`.
**Nodes.** `72:15697`, `48:6560`, `31:6438`.
**Depends.** T0, T1.

**Shipped (DEV-2156).** `Toolbar.tsx` deleted; its job split across `TopBar.tsx`,
`EditorBar.tsx`, `PreviewBar.tsx`, `AuthedActionBar.tsx` and a shared `MenuButton.tsx`.
Three measured corrections to the scope above:

- **Row 2 is two bars, not one.** `72:15811` sits inside the editor column frame and `72:15706`
  inside the preview column frame — there is no full-width secondary row. The only rule at that
  height is the sidebar/editor boundary, which `s.sidebar`'s `borderRight` already draws, so
  there is no divider component either.
- **The preview column is a fixed half.** It starts at `x=864` of 1728 in *both* `72:15697`
  (sidebar collapsed) and `48:6560` (sidebar open at 240) — the editor absorbs the sidebar.
  `s.body` is `240px minmax(0,1fr) 50%`; `1fr 1fr` would put the boundary at 984. T6 replaces
  this with the draggable ratio.
- **`Download` is not gated on auth.** The scope line says `Download` (authed) / `Sign in`
  (anon), but share mode has always offered Download to anonymous visitors and no frame shows an
  anonymous share view. Ground rule 1 wins: Download renders whenever a file set exists, Sign in
  when anonymous, and an anonymous share page shows both.

The refresh button needed a `reload()` on `DemoRuntime` (`types.ts`, `container.ts`,
`sandpack.ts`) — container re-points the iframe at its existing `previewUrl`, Sandpack re-runs
`updateSandbox(setup, true)`. Neither creates a session: a remount would mint a fresh container
per click against a five-slot pool.

Also landed here: `PreviewPane`'s full-width accent status strip is gone (the design gives the
preview one bar, and `● ready` belongs in T5's *bottom* bar); the tab strip renders inline in
`EditorBar` with one open file, and T4 extracts it; `App.tsx` now captures `mount()`'s
`previewUrl` for the row-2 address field.

Two things the pill did to `DocsCascader` that T7 should know about, since T2 only meant to
restyle its trigger. Its `trigger` lost its border/background — the pill is the one box the
design draws (`72:15859`), and keeping both nested two. And `s.pop` gained
`width: max-content` plus `s.topBar` a `zIndex`: the pill is centred with a `transform`, which
makes it a stacking context, so without that the preview pane — `position: relative`, later in
the DOM — painted straight over the open popover.

---

## T3 — Left sidebar: BOX INFO / FILES / DEPENDENCIES

**Scope.** Three collapsible sections replacing today's flat `FileTree`.
- **BOX INFO** — title, description, Handsontable badge, created date. Data already exists:
  `demos` carries `title`/`description`/`created_at`, API returns all three
  (`workers/api/src/index.ts:146-151`). Display only, no backend work. **New — build now.**
- **FILES** — real folder tree (`src/` expandable), seti-ui icons, download-all icon.
- **DEPENDENCIES** — parse `package.json`, list name + npm link. **New — build now** (small).
- Collapsed-sidebar state driven from the row-2 toggle.

### File add / rename / delete — gate per mode (decided)

`addFile`/`renameFile`/`deleteFile` are implemented (`App.tsx:665-698`) and passed
**unconditionally** (`App.tsx:967-969`); `FileTree` renders `+` / ✎ / ✕ whenever handlers
exist (`EditorShell.tsx:91`) — so today they appear in every mode, share included.

**Follow the design:** expose them only where the design calls for them. Sticky `72:14532`
names "fork/view" as the modes without them, which maps to the shell's `play` and `share`
modes; `edit` (your own saved demo) keeps full CRUD.

| mode | today | after |
|---|---|---|
| `play` — playground / docs example | CRUD shown | **hidden** |
| `share` — read-only public playground | CRUD shown | **hidden** |
| `edit` — your saved demo | CRUD shown | CRUD kept, restyled |

Implementation: pass the handlers conditionally on `mode === "edit"` rather than deleting
anything — `App.tsx:967-969`. Keep `editable` as the shell's switch.

Scope note: this governs the **file set** only. Editing file *contents* is unchanged in all
three modes.

> Worth one line of confirmation from design at review: no frame anywhere in `18.1` shows a
> `+` control, so "keep CRUD in `edit`" is a reading of the sticky's wording, not something a
> frame demonstrates.

**Files.** `FileTree.tsx` split into `Sidebar.tsx` / `FileTree.tsx` / `BoxInfo.tsx` / `Dependencies.tsx`.
**Nodes.** `31:6438` (nested), `48:6560` (flat), `65:19433` (collapsed).
**Depends.** T0, T1.

---

## T4 — Editor pane: file tabs + status bar

**Scope.** Build the tab strip to the design — tab shape, active state, file-type icon, close ✕
— but **one open file at a time**. `EditorShell` keeps its single `active` string; selecting a
file in the tree replaces the tab. No new tab state, no multi-tab bookkeeping.

**Multi-tab is a deliberate gap for a future task.** The design shows two tabs
(`index.ts`, `index.html`); we ship the visual system now and add real multi-file tabs later
without re-designing anything.

Bottom status bar: `Ln 1, Col 1 · Spaces: 2 · UTF-8 · Layout: U.S.` — needs CodeMirror cursor
position surfaced. New, small — build now.

**Files.** `EditorShell.tsx`, `CodeEditor.tsx`, new `EditorTabs.tsx`, `EditorStatusBar.tsx`.
**Nodes.** `48:6560`, `31:6438`.
**Depends.** T0, T1.

**Shipped (DEV-2158).** `EditorTabs.tsx` + `EditorStatusBar.tsx`, both re-exported from the
barrel, slotted into `s.editorPane` around a new `s.editorBody` wrapper (`flex: 1; minHeight: 0;
overflow: hidden` — without the last one CodeMirror's scroller pushes the status bar out of the
pane). Measured off `31:6598` / `31:6618`: strip 36px on `surfaceSunken`, active tab
`surfaceRaised` with a 24px seti icon, 12px label, 16px `IconX`; status bar 28px on `editorBg`,
`4px 16px`, 24px gaps, 10px `textMuted`. The strip's bottom hairline is an **inset shadow**, not
a border — inset shadows paint below children, so the active tab's opaque background covers it
while transparent inactive tabs let it through, which is the frames' behaviour without any
negative margins. Both tab states are written out although only the active one renders, so
multi-tab is a state change rather than a restyle. T4 is the first consumer of T1's `FileIcon`.

Cursor position comes from `onUpdate` on `@uiw/react-codemirror`, derived as
`head - lineAt(head).from + 1`, not from `onStatistics` — whose `line` is
`lineAt(selection.main.from)`, the wrong line for an upward multi-line selection, and which
carries no column. The handler is an empty-dep `useCallback` reading a ref: `useCodeMirror`
installs `onUpdate` as an *extension*, so an unstable handler churns the editor's extensions on
every render while this one sets state in the shell. Verified in a browser against the compound
path — real typing, where `docChanged` fans out to both `setCursor` here and `onEdit` up into the
app and back down as a new `value` — with zero idle DOM mutations in the pane afterwards and no
frame-rate regression. `Spaces: 2` / `UTF-8` / `Layout: U.S.` are static; see open items 6–8.

One consequence of `s.editorBody`'s clip worth recording: CodeMirror parents its tooltips inside
the editor, so completion popups are now clipped 28px higher than before. CM6 measures the space
available and flips upward rather than being sheared — checked with the caret 5px above the clip
edge, where the popup opened fully inside the pane. No `tooltipSpace` configuration needed.

---

## T5 — Preview pane chrome + boot / loading / refresh states

**Scope.** Status bar moves from a full-width colored bar at the top of the preview to a
bottom bar (`● ready` · `React (Vite, TS)` · `Handsontable 18.0.0`). URL bar + refresh +
open-in-new land in row 2 (T2). Refresh-in-flight spinner over the pane.

**Boot log stays.** The design shows only a spinner + "Loading data …" and omits the live
Tier-2 install/dev-server log. That log is the main signal when a container is slow or stuck —
treated as a **gap in the design, not a removal**. Keep it; restyle it to the token set and
put it under the spinner (or behind a "Details" disclosure), implementer's call.

Error state has **no frame** — restyle the existing one to the design system (T9 rule).

**Files.** `PreviewPane.tsx`, `styles.ts`.
**Nodes.** `72:14610` (loading), `72:26445` (refresh), `48:6560` (ready).
**Depends.** T0, T1.

---

## T6 — Resizable split

**Scope.** Draggable splitter between editor and preview (blue active handle, `85:9970`), min
widths, ratio persisted. `s.body` is a fixed `220px 1fr 1fr` grid today.

Panel show/hide toggles are **not in the design** (see the row-2 icon inventory) — dropped.

*New, self-contained, low risk — **build now**.*

**Files.** `EditorShell.tsx`, `styles.ts`, new `SplitPane.tsx`.
**Nodes.** `85:9970`, `85:16935`.
**Depends.** T0.

---

## T7 — Example picker cascader

**Scope.** Restyle the existing `DocsCascader.tsx` to the design's popover: search input +
category column → grouped example column with section headers (`CONTEXT MENU`,
`DRAG TO SCROLL`, `EMPTY DATA STATE`, …). Behaviour already exists (starters + docs examples,
framework auto-pick via `FW_PREF`) — keep it.

**Files.** `apps/authoring/src/DocsCascader.tsx`, `docs-catalog.ts` (grouping/search helpers).
**Nodes.** `72:17078`.
**Depends.** T0, T1, T2.

---

## T8 — Modes & routes: full / logged-out

**Scope.**
- `?mode=full` — top bar + URL bar + preview + bottom status bar, no editor/sidebar
  (`65:20432`). This is the authoring app wrapping the static `/d/:id/` build in an iframe
  (`App.tsx:136-143`), so the chrome is shell code.
- Logged-out — `Sign in` instead of `Download`; version + framework selectors visible (`72:15697`).

**`/d/:id` and `/embed/:id` are out of scope.** They are prebuilt static R2 artifacts streamed
by `serveDemoAsset` (`workers/api/src/share.ts:353`) and contain no shell code. Embed shows the
preview and nothing else — no chrome to design. Frames `72:11913` / `72:13670` need no work.

**Files.** `apps/authoring/src/App.tsx`, `EditorShell.tsx`.
**Depends.** T2–T6.

---

## T9 — Apply the design system to existing, undesigned functionality

No Figma frames exist for any of these. They stay; they get rebuilt against the T0 token set
and the T1 icon set, to dev judgment.

- My demos list + empty state (`MyDemos.tsx`)
- Share / Edit dialogs, copy affordances, revoke/delete confirmations (`ShareDialog.tsx`, `ShareLinks.tsx`)
- Error states — preview failure, container failure, revoked/404 demo
- Branding: favicon, page titles, meta
- Responsive / narrow viewport. The two "Resize" frames are the **splitter drag**, not a
  breakpoint study — there is no mobile or tablet frame anywhere in section `18.1`.

**Depends.** T0, T1. Can run in parallel with T2–T7.

---

## Ordering

```
T0 tokens ──┬── T2 chrome ──┬── T7 cascader ──┐
T1 icons ───┤   T3 sidebar  │                 ├── T8 modes
            │   T4 tabs     │                 │
            │   T5 preview  │                 │
            ├── T6 split ───┘                 │
            └── T9 undesigned surfaces ───────┘
```

T0 lands first and alone — every other subtask rebases on it. T1 runs alongside. T2–T7 and T9
parallelize once both land. All PRs target `feat/DEV-2027-redesign`; one deploy from it.

**Possible merges if 9 subtasks is too many:** T4+T5 (both pane chrome), T2+T7 (the cascader is
the pill's behaviour), T6 into T2.

## Deliberate gaps — designed but deferred to future tasks

- **Multi-file tabs.** Tab strip ships styled, single active file. (T4)
- **Embed theme handling.** The app emits a preferred-theme hint; acting on it is not
  DEV-2027. (T0)

## Open items raised during implementation

A running log. Subtasks **append** here rather than resolving inline — the calls get made in one
pass at the end of the redesign, so nothing blocks a subtask from landing. Each item names the
subtask that surfaced it and what evidence exists.

| # | Item | Kind | Raised by |
|---|---|---|---|
| 1 | Dark `textMuted` deviates from the Figma variable | design decision | T0 |
| 2 | `ShareDialog.tsx` is dead code the docs still reference | cleanup + doc fix | T0 |
| 3 | Angular container ignores global `styles.css` edits | potential bug | T0 |
| 4 | Two file rows in `31:6438` use an icon seti's own mapping doesn't give them | design decision | T1 |
| 5 | T1's scope line says "panel toggles"; the design has none | doc fix | T1 |
| 6 | No token pair matches the tab strip in both modes | design decision | T4 |
| 7 | The ramp table puts both status bars on `surfaceMuted`; measurement says `editorBg` | doc fix | T4 |
| 8 | `Spaces: 2` / `UTF-8` / `Layout: U.S.` are static labels | design decision | T4 |
| 9 | The tab close ✕ is decorative until multi-tab lands | design decision | T4 |
| 10 | The active tab's left border in the frame is a light-mode `text` colour | design decision | T4 |
| 11 | GitHub Dark's own background is a step darker than `editorBg` | design decision | T4 |
| 12 | The universal `button:hover` rollover now dims the active tab | design decision | T4 |
| 13 | The example pill's 20×20 Handsontable mark has no asset in the repo | asset gap | T2 |
| 14 | Tier-1 has no preview URL to put in the row-2 address field | design decision | T2 |

### 1. Dark `textMuted` — `#8f8f94`, not the Figma `#727272` (design decision)

`component/buttons/icon/enabled/icon-button-icon-color` is `#727272` in the dark frame, which
lands at roughly 3.9:1 on `surface` `#070604` — under WCAG AA for normal text. `theme.ts` ships
`#8f8f94` instead.

The Figma value may well be intended for *icons* (where AA for text doesn't apply) rather than
the muted body text the shell uses the token for, in which case the real fix is two tokens —
`textMuted` and an `iconMuted` — not one lightened value. Needs a design call.

### 2. `ShareDialog.tsx` is dead code (cleanup + doc fix)

Nothing imports it. The live flow is `ShareLinks.tsx`, reached from `App.tsx`. Both DEV-2154 and
ADR-0022 name `ShareDialog.tsx` as *the* surface that hands out the embed URL, so those
references are stale — the ADR's file citation is wrong, not just incomplete.

T0 tokenised it and gave it the theme hint anyway, so it stays consistent if someone revives it.
Decide: delete it and correct ADR-0022's wording, or wire it back. Touches T9 (dialog surfaces).

### 3. Angular container ignores global `styles.css` edits (potential bug)

Found while running `runner:verify` for T0, in the Tier-2 Angular starter. Not caused by the
theming work — the shell's push path is demonstrably fine — and not investigated further.

Observed: editing `src/styles.css` in the editor pushes successfully
(`POST /api/session/:id/file` → 204) but the rule never applies in the preview within 30s.
Editing `src/app/data-grid.component.ts` in the same session applies in ~2s. So the transport
works and Angular's rebuild works; only global-stylesheet changes fail to reach the page.

Not established: whether this predates the redesign branch, whether it affects the other Tier-2
frameworks (Next.js, Nuxt, Astro, Remix) or is Angular-specific, and whether the container's dev
server rebuilds the stylesheet at all versus rebuilding it but not reloading it. A user editing
CSS in an Angular demo sees nothing happen, so it is worth a real look — likely its own ticket
outside DEV-2027.

### 4. `index.html` and `tsconfig.json` are drawn with the `ejs` icon (design decision)

The frames take their file icons from seti-ui's raw `.svg` files, baked fills and all — sampled
out of `72:16991`, `main.ts` is `#529bba` (`typescript.svg`'s own fill) and `pnpm-lock.yaml` is
`#9f74b3` (`yml.svg`'s). T1 instead resolves colour through `mapping.less` + `ui-variables.less`,
which is what seti's own editor does and the only place per-key colours exist (`.test.ts` is an
*orange* typescript, `.ts` a blue one). Two consequences:

- **Glyph mismatch, two rows.** `72:17026` (`index.html`) and `72:17056` (`tsconfig.json`) are
  both the layer `ejs 1`, measured `#d3c238` — the yellow `ejs` icon. seti maps `.html` to
  `html`/orange and `tsconfig.json` to `tsconfig`/blue, which is what ships. Reads like the
  designer grabbed a neighbouring sheet cell; worth one line of confirmation.
- **Hex drift, every row.** Mapping values sit 1–2 units off the baked fills (`#519aba` vs
  `#529bba`, `#a074c4` vs `#9f74b3`). Imperceptible, and not worth abandoning per-key colour for.

Everything else matches the frame exactly: `main.ts`/`index.ts` typescript blue, `styles.css` css
blue, `package.json` the generic json yellow (seti has no `package.json` entry — it falls through
to `.json`, precisely as drawn), `pnpm-lock.yaml` yml purple, the `src` folder `#ababab`.

### 5. T1's scope line says "panel toggles"; the design has none (doc fix)

`:105` above lists "panel toggles" among the tabler icons to ship, and `:52` states — from the
`72:15697` layer names — that there are no panel-toggle buttons in the design. T1 shipped no such
icon. The scope line is the stale half; T2 dropping the toggles is the settled call.

### 6. No token pair matches the tab strip in both modes (design decision)

Sampled from the two frames, the tab strip is `#f7f7f9` light / `#070604` dark — the same colour
the frames give the **left sidebar** and the **preview surround**, in both modes. No shipped token
is that pair: `surfaceSunken` is `#f7f7f9`/`#000000`, `surface` is `#ffffff`/`#070604`.

T4 ships `surfaceSunken`, so the strip matches the sidebar (`styles.ts:80`) as the frames do, and
is exact in light. `surface` is not merely a worse fit but unusable: it is `#ffffff` in light,
identical to the active tab's `surfaceRaised`, so the active state would vanish in light mode.

The underlying question is T0's, not T4's: the ramp reads the four steps as
`sunken #000000 < surface #070604 < muted #19191c < raised #222222`, while the frames paint
sidebar, tab strip and preview surround all at `#070604` and reserve `#000000` for nothing. Either
the frames collapse two steps the ramp separates, or `surfaceSunken` should be `#070604` and the
ramp has one step too many. One design call fixes both surfaces.

### 7. Both status bars measure `editorBg`, not `surfaceMuted` (doc fix)

The ramp table at `:83` assigns `surfaceMuted` to "editor pane, both status bars". Measured, the
editor pane, the editor status bar and the preview status bar are all `#ffffff` / `#19191c` —
which is `editorBg`, and which is what T0 actually shipped for the pane (`styles.ts:108`).
`surfaceMuted` is `#f7f7f9` in light, so the table is right in dark and wrong in light. T4's
status bar uses `editorBg`; T5 will hit the same row for the preview bar.

### 8. `Spaces: 2` / `UTF-8` / `Layout: U.S.` are static labels (design decision)

Only `Ln n, Col n` has a live source. `Statistics.tabSize` reports the CM6 default rather than the
design's 2, and `indentUnit` — the extension that would make the label true — lives in
`@codemirror/language`, which `@uiw/react-codemirror` does not re-export and which the package
does not depend on. Adding `EditorState.tabSize.of(2)` would only change how a literal tab
renders, and our files are space-indented, so it would buy nothing observable while implying the
label is derived. Encoding and keyboard layout have no source at all in a browser editor.

Decide whether the three stay as design decoration, or the two that could be made real
(indent size, and encoding as a constant) get wired to something. Nothing depends on this.

### 9. The tab close ✕ is decorative until multi-tab lands (design decision)

With one open file there is no close action: closing would leave an empty editor. T4 renders the
glyph `aria-hidden` and non-interactive rather than as a `disabled` button, which would imply an
action that becomes available later. It becomes a real button with multi-tab support (ADR-0023).

### 10. The active tab's left border is `#262624` in the frame (design decision)

`31:6602` binds its left border to `horizon/palette/700` — `#262624`, which is the shell's light
`text`. Against a light tab strip that is a near-black hairline; in dark it is indistinguishable
from `border` `#222222`. Inactive tabs use `palette/800` (= `border`) for the same edge. Read as a
Figma slip and shipped as `border` for both. Worth one line of confirmation at review.

### 11. GitHub Dark is a step darker than `editorBg` (design decision)

The dark frames paint the editor body `#19191c`, which is what `editorBg` gives the pane. The
CodeMirror theme T0 chose to match the docs site paints its own `#0d1117`, so in dark mode the
editor content sits a step darker than the pane it is in. Invisible until now, because CodeMirror
filled the pane edge to edge; T4's status bar puts `#19191c` directly beneath `#0d1117` and makes
the seam legible. Light is unaffected — GitHub Light is `#ffffff`, exactly `editorBg`.

Either the frames' editor body was drawn without the real CM theme in mind, or the dark editor
wants a tokenised CodeMirror theme rather than `githubDark`. Not T4's call to make.

### 12. The universal `button:hover` rollover reaches the tabs (design decision)

`apps/authoring/index.html:37` applies `filter: brightness(0.92)` to every `button` and `a` as a
deliberate universal rollover. A tab is a button, so hovering one dims it — including the *active*
tab and its seti icon, which no frame asks for. It is the same treatment every existing button in
the app already gets, so T4 changed nothing here and left it alone.

Decide at review whether tabs want a real hover (an inactive tab lifting to `hover`, the active
one inert, which is the usual editor idiom) or whether the universal rollover is enough. A real
one needs a class, since `:hover` cannot be expressed inline — the same reason `.hot-icon-btn`
exists.

### 13. The example pill's Handsontable mark has no asset (asset gap)

Both pill forms draw a 20×20 rounded-square Handsontable mark to the left of the label —
`48:6582` (`image 3`) and `72:15861` (`image 2`). The repo has only the 145×22 wordmark
(`logo.svg` / `logo-light.svg`), which at 20px tall is ~130px wide and swamps the pill. T2 ships
the pill without a leading mark.

The same gap blocks the favicon, which T9 lists and which currently 404s in dev. One square
mark asset (two inks, or `currentColor`) closes both. Needs the file from design.

### 14. Tier 1 has no preview URL for the row-2 address field (design decision)

The field shows the demo's public URL when it has one, else the URL `mount()` reports. Tier 2
gives the container's preview origin. Tier 1 does not: `SandpackRuntime.mount` returns
`this.opts.iframe.src` (`sandpack.ts:195`), which at that moment is Sandpack's *bundler* origin
— `https://…sandpack.codesandbox.io/`. That is both meaningless to the user and a CodeSandbox
mark, which ADR-0001 keeps out of the UI. T2 therefore surfaces the URL only for the container
engine and renders a muted `Live preview` placeholder otherwise.

So an anonymous playground on a Tier-1 starter — the exact case `72:15697` draws with a
`/share/…` URL in the field — shows the placeholder. Options if that reads as empty: drop the
field when there is no URL, or show the browser's own address. Worth one line from design.

## Remaining decisions

None blocking. One item to confirm with design during review: whether `edit` mode keeps the
file `+` / ✎ / ✕ controls (T3) — no frame shows them anywhere, so the plan reads that from
sticky `72:14532`'s wording.

*Resolved:* theme drives the whole app, embed handling out of scope (T0) · `/d/:id` +
`/embed/:id` dropped (T8) · framework select is a restyle of existing docs-example buttons,
starters unaffected (T2) · authed actions get their own bar in the right panel above the
preview, signed-in only (T2) · boot log stays (T5) · tabs styled but single-file (T4) · file
CRUD gated to `edit` mode (T3) · undesigned surfaces get the design system, not deletion (T9) ·
integration branch + sub-PRs, single deploy.
