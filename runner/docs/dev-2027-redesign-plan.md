# DEV-2027 — Demo runner UI/UX redesign — subtask breakdown

Task: [DEV-2027](https://app.clickup.com/t/86camqwaw)
Design: [Figma Sandbox / section `18.1`](https://www.figma.com/design/KCl2Csh9WUSwCrddffnYuD/Sandbox?node-id=72-18175) (fileKey `KCl2Csh9WUSwCrddffnYuD`)
Repo: `handsontable/examples` → `runner/packages/editor-shell/src/` + `runner/apps/authoring/src/`
Decisions: [ADR-0022](adr/0022-shell-theming-via-css-custom-properties.md) (theming),
[ADR-0023](adr/0023-redesign-scope-and-shipping.md) (scope rules, deferred gaps, shipping),
[ADR-0025](adr/0025-redesign-scope-corrections-after-login-frames.md) (scope corrections — supersedes
three of ADR-0023's applied decisions)

> **Read this first if you are picking up work here.** The **After Login** section (`114:*`) was added
> to the Figma file *after* these subtasks were written. T9 re-derived against it; **T2–T8 did not**, so
> three shipped decisions rested on premises those frames falsify. The audit is
> [`dev-2027-figma-gap-audit.md`](dev-2027-figma-gap-audit.md), the decisions are ADR-0025, and the
> follow-up work is subtasks **T10–T14** below. Where a section's shipped notes conflict with ADR-0025,
> ADR-0025 wins.

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
| `65:24280` | Mode Full | Light, full-width preview; Download + theme top-right, `window-minimize` |
| `65:17596` | Fork preview — Dark mode / Light example | Full frame; BOX INFO chevron only, CRUD hidden |
| `65:23282` | Light mode / Light example | Light twin of `65:19433` — sidebar collapsed |

The last three rows were listed as *"not rendered — name-inferred"* (and `65:23282` was missing) until
the gap audit read them. All render fully, and their content **confirms** what T3 and T8 shipped.

### After Login section (`114:*`) — added to Figma after these subtasks were written

| Node | Name | What it shows |
|---|---|---|
| `114:21146` | After Login Example | **Complete signed-in workspace** — `Fork` in the top bar, `share` in the preview bar, a pencil on the version pill, CRUD unhidden in the sidebar, a dirty dot on the active tab |
| `114:21480` | Menu | Account popover — My demos / Settings (greyed) / Log out |
| `114:23289` | Sahre links *(sic)* | Share dialog over the authed workspace |
| `114:24410` | Sandbox info edit | Edit-info dialog — Title, Description, Save / Cancel |
| `114:25521` | After Login Example | My Demos page — 320px nav, card grid, kebab, `+ Create` |
| `114:26833` | After Login Example | Settings page — Name, Description, avatar Upload / Remove |

T9 built to the last four. **`114:21146` was absent from this index entirely** and is the frame that
drives ADR-0025; its chrome findings were verified across all four workspace frames, not read off one.

Sticky notes (decisions baked into the design):
- `11:2535` — code colors = same as docs, GitHub Theme Dark/Light
- `11:2545` — icons = tabler-icons + seti-ui (file icons)
- `72:16829` — book icon → docs page, github icon → example repo
- `72:14527` — embed iframe: `body { margin: 0 }` → **out of scope**, `/embed/:id` dropped (T8)
- `72:14532` — no rename / delete / add file in the sidebar in fork/view mode
  → **conflicts with ground rule 1** (that CRUD exists and works). See T3, then **ADR-0025**: read
  together with `114:26599`, "fork/view" means *not signed in*, which is how the two stickies reconcile.
- `114:26599` — **"CRUD w sidebar po zalogowaniu"** (*CRUD in the sidebar after logging in*) → settles the
  gate as auth-based, not mode-based, superseding T3's reading. See open item 41.
- `114:26732` — "Ta strefa w przyszlosci moze sie rozrosnac o inne elementy, zarzadzanie userami,
  folderami etc." (*this zone may grow: user management, folders…*), beside My Demos' left nav →
  forward-looking, no work now; confirms the 320px rail is meant as a real nav. Relevant to item 33.

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

**Embed:** the app appends a *preferred* theme to the embed URL it hands out — built in
`apps/authoring/src/App.tsx` and surfaced through `ShareLinks.tsx`. Those two files are
the whole of it. How the embed acts on that hint is **out of scope for DEV-2027**.
(This originally named `ShareDialog.tsx`, which nothing imported; T9 deleted it — open item 2.)

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

> **SUPERSEDED by ADR-0025 → T10.** "Appear in no frame" expired when the After Login section landed.
> `Fork` is in the top bar (4/4 workspace frames), `Share` is a preview-bar icon (3/4), and the
> custom-version input is a pencil on the version pill (`114:24396`). `Embed` needs no surface — it is
> the same `POST /api/demos` as `Fork` and its output is already the Share dialog's third row, so the
> share icon becomes mode-aware. Only `Save` stays undesigned. **The bar is retired.** Prerequisite: an
> icon-form pending treatment, since a 36px button cannot render "Creating…".

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

`addFile`/`deleteFile`/`renameFile` are implemented (`App.tsx:696-730`) and were passed
**unconditionally** (`App.tsx:897-899` as T2 left them, now `913-915` with the gate);
`FileTree` renders `+` / ✎ / ✕ whenever handlers exist — so before T3 they appeared in every
mode, share included. Line numbers here are post-T3; they have moved once per subtask so far.

**Follow the design:** expose them only where the design calls for them. Sticky `72:14532`
names "fork/view" as the modes without them, which maps to the shell's `play` and `share`
modes; `edit` (your own saved demo) keeps full CRUD.

| mode | today | after |
|---|---|---|
| `play` — playground / docs example | CRUD shown | **hidden** |
| `share` — read-only public playground | CRUD shown | **hidden** |
| `edit` — your saved demo | CRUD shown | CRUD kept, restyled |

> **SUPERSEDED by ADR-0025 → T11.** The gate is **auth**, not mode. Sticky `114:26599` says so
> ("CRUD w sidebar po zalogowaniu"), and the `hidden` flag on `folder-plus`/`plus` is bimodal across the
> file: hidden in all 7 Before Login / Fork preview frames, visible in all 4 After Login frames. So
> "fork/view" in sticky `72:14532` means *not signed in*. New gate:
> `!!user && mode !== "share"` — the `play` row above flips to **CRUD when signed in**. `share` stays
> excluded: the design never models ownership, so no frame shows a signed-in visitor on someone else's
> demo, and granting CRUD there would be a behaviour change rather than a restyle.

Implementation: pass the handlers conditionally on `mode === "edit"` rather than deleting
anything. Keep `editable` as the shell's switch. Gate only the two CRUD buttons, not the header
group they sit in — the download-all icon and the collapse chevron share `72:16994` and must
render in every mode.

Scope note: this governs the **file set** only. Editing file *contents* is unchanged in all
three modes.

> ~~Worth one line of confirmation from design at review: no frame anywhere in `18.1` shows a
> `+` control, so "keep CRUD in `edit`" is a reading of the sticky's wording, not something a
> frame demonstrates.~~ **Closed by layer data** — see the resolution below.

**Files.** `FileTree.tsx` split into `Sidebar.tsx` / `FileTree.tsx` / `BoxInfo.tsx` / `Dependencies.tsx`.
**Nodes.** `31:6438` (nested), `48:6560` (flat), `65:19433` (collapsed).
**Depends.** T0, T1.

**Shipped (DEV-2157).** `Sidebar.tsx` composes `BoxInfo.tsx` + `FileTree.tsx` +
`Dependencies.tsx`, with the shared section chrome in `SectionHeader.tsx` — its own module
rather than a local helper, because `FileTree` renders its own header and importing it from
`Sidebar` would be a cycle. `FileTree` keeps its name and its `(paths, active, onSelect)`
contract but is now the FILES *section*, not the column. First consumer of T1's icon layer.

Four things worth carrying forward:

- **The `+` caveat above is closed, and the design does have CRUD.** The FILES header group
  `72:16994` contains `72:16999 tabler-icon-folder-plus` and `72:17001 tabler-icon-plus`, both
  `hidden="true"`, and every file row carries `tabler-icon-pencil` / `tabler-icon-trash-x` at
  `opacity-0`. It is a hidden layer variant for the non-edit state, not an absence. Two
  consequences: `+`/`folder-plus` belong in the section *header* (not their own row), and
  pencil/trash are per-row and hover-revealed. Both implemented that way.
- **Directory expansion stores *collapsed* paths, not expanded ones.** `props.files` is
  replaced wholesale on every example switch and `mountGen` does not re-key `EditorShell`
  (`App.tsx:657-658`), so a set seeded with expanded dirs leaves the *new* workspace's folders
  shut. Verified: shutting two dirs on the Vue starter then switching in-session to Next.js
  gives 9 directories, all expanded.
- **Empty directories are not representable.** `FilesMap` is flat
  (`packages/runtime/src/types.ts:6`), so a directory exists only as some file's path prefix.
  `folder-plus` therefore means "new file under a new prefix", and deleting a directory's last
  file makes the directory disappear. Both are correct, not defects.
- **`created_at` needed client work despite "no backend work".** The worker already returned it
  via `publicView` (`workers/api/src/index.ts:151`), but the app's metadata cast picked only
  three fields — so the field was added to the cast plus a `createdAt` state var.

The sidebar toggle came from T2 (`sidebarOpen` in `EditorShell` + `EditorBar`); T3 deliberately
added no second source of truth. Download-all reuses `downloadZip`, the same callback the top
bar's `onDownload` takes — one zip path, not two.

---

## T4 — Editor pane: file tabs + status bar

**Scope.** Build the tab strip to the design — tab shape, active state, file-type icon, close ✕
— but **one open file at a time**. `EditorShell` keeps its single `active` string; selecting a
file in the tree replaces the tab. No new tab state, no multi-tab bookkeeping.

**Multi-tab is a deliberate gap for a future task.** The design shows two tabs
(`index.ts`, `index.html`); we ship the visual system now and add real multi-file tabs later
without re-designing anything.

> **SUPERSEDED by ADR-0025 → T12.** Multi-file tabs are in scope. T4's bet paid off — both tab states
> were written out, so this is a state change rather than a restyle. What T4 could not know: `dirty` is a
> single workspace-level boolean, so a truthful per-tab dot needs per-file tracking. Undesigned and
> decided inside T12: tab overflow, the last-tab-closed empty state, per-file undo history (`CodeEditor`
> is keyed on `active`, so switching remounts CodeMirror), and open-set persistence.

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

**Shipped (DEV-2159).** New `PreviewStatusBar.tsx` + `Spinner.tsx`; `s.statusBar()` deleted
(orphaned since T2 removed the strip it styled).

**The bar is a sibling of `PreviewPane`, not a child.** Every overlay in that section is
`position: absolute; inset: 0`, so a bar inside it is painted over by the boot, error and
refresh overlays — which is exactly why the pre-T2 top strip had to buy its way out with
`inset: "28px 0 0 0"` on each overlay. As the preview column's last child it also lands in
the same band as `EditorStatusBar` with no arithmetic: measured flush at `top: 734,
height: 28` in a 762px viewport, with T6's 1px splitter track between them. `48:6701` and
`48:6740` are both y=800 h=28 inside their own column frames, which is that band.

Geometry off `48:6701`: 28px, `4px 16px`, 6px `success` dot 4px from its label, right group
`marginLeft: auto` with a 12px gap. Both bars share `s.paneStatusBar` on `editorBg`
(#ffffff / #19191c, exact) — sharing the object is what stops them drifting apart.
`previewBg` is wrong here: #070604 in dark, a step darker, where the frames paint this band
*lighter* than the preview surround. Extends open item 7.

`data-preview-status` and `aria-label="Preview"` stay on the `<section>`, iframe still a
descendant: `e2e/starter-matrix.spec.ts:144` polls the first, `e2e/docs-examples.spec.ts:305`
selects on the second. Verified after the restructure.

**`reload()` now returns `Promise<void>`** (`types.ts`, `container.ts`, `sandpack.ts`), which
is what the refresh spinner waits on. It never rejects — failure already has `onError`.

The two tiers settle on genuinely different things, and the difference is not cosmetic.
Container resolves on the reloaded page's `load`: `src` navigation is what a refresh *is*, and
`load` fires on the frame element regardless of origin, with a 10s timeout and `dispose()` as
backstops. Sandpack resolves on **its own transpile + dispatch**, because the bundler sends
nothing back for an `updateSandbox(setup, true)` — see open item 26, which records the
measurement and what a follow-up should not re-derive. Building it on `done` made every Tier-1
refresh hold a spinner over a blanked pane for the full 10s timeout.

**The boot overlay is gated on the engine, not on `bootLog` being non-empty.** The first cut
inferred the tier from the log, which read correctly until a wedged container pool made
`POST /api/session` hang for 100s+ — and the log only starts arriving *after* that request
returns, so the window where the user most needs to be told the wait is expected is the
window with no log to infer it from. `containerBoot` is now an explicit prop. Tier 1 gets
the designed spinner and "Loading data …" alone; Tier 2 adds the wait explanation, the newest
log line (`Preparing container…` until the first arrives) and the tail behind `Details`.

`Details` is a button plus a chevron rather than `<details>`/`<summary>`: hiding the native
marker needs `list-style: none` *and* `::-webkit-details-marker { display: none }`, both
pseudo-element rules inline styles cannot express, and `editor-shell` may not reach the app's
global block — the same constraint that moved `hot-spin`'s keyframes into `THEME_CSS`.

`syncing` stays the non-blocking corner badge, restyled. It fires on Tier-2 keystroke bursts;
blanking the grid per keystroke is worse than a badge. `refreshing` suppresses it — the pane
is already blank behind the refresh spinner.

Also here: `Splash` rebuilt to `72:14610` (spinner + one line), and `frameworkName` added as
its own prop rather than repurposing `frameworkLabel` — for a docs example `entry.displayName`
is the long `"Columns ▸ … · Standard example · React (TS)"` breadcrumb, so the short label is
resolved through the starter catalog by framework key (`.find`, not `getEntry`, which throws).

---

## T6 — Resizable split

**Scope.** Draggable splitter between editor and preview (blue active handle, `85:9970`), min
widths, ratio persisted. `s.body` was a fixed `240px minmax(0,1fr) 50%` grid — *not* the
`220px 1fr 1fr` this line claimed before T6 measured it.

Panel show/hide toggles are **not in the design** (see the row-2 icon inventory) — dropped.

**Files.** `EditorShell.tsx`, `styles.ts`, new `SplitPane.tsx`.
**Nodes.** `85:9970` (**dark**), `85:16935` (**light**) — the labels were the other way round
here and in the ticket.
**Depends.** T0.

**Shipped (DEV-2160).** `useSplitPane()` + `<SplitHandle>` in `SplitPane.tsx`; the grid stays in
`s.body`, which already encoded the rule the ratio has to respect. Four measured points:

- **The ratio is a fraction of the whole body, sidebar track included.** That is what T2
  measured (preview from x=864 of 1728 with the sidebar both open and collapsed), so keeping the
  fraction body-relative is what stops the sidebar toggle from moving the seam — asserted in
  `e2e/splitter.spec.ts`. `s.body` is now
  `240px minmax(0,1fr) 1px var(--hot-split, 50%)`; the 1px track *is* the splitter, so
  `s.column`'s `divided` branch and the editor's `borderRight` are gone.
- **Line `85:11001` spans the full body** (y=72, h=828) — through both row-2 bars and both status
  bars. A grid track does that for free. Rendered output matches the frames to the pixel: 3px,
  `#1A42E8` light / `#4669F6` dark while dragging, the 1px `border` token at rest.
- **The active blue needed its own token pair.** Light is plain `accent`; dark is *lifted* to
  `#4669F6`, which is neither `accent` nor dark `accentHover` (`#3b5cf0`). Hence
  `splitterActive`. Both frames are the drag state only, so the accent shows on hover, focus and
  drag — never at rest.
- **The ratio reaches the DOM two ways, deliberately.** React renders it as an inline custom
  property so a restored ratio is correct in the first paint; the drag then writes that same
  property straight onto the node, since a render per `pointermove` walks the keyed CodeMirror
  instance and the preview pane. State and `localStorage` are touched once, on `pointerup`.
  A `useLayoutEffect` was the first attempt and is **wrong** here — see open item 18.

The drag survives the preview iframe through `setPointerCapture` *and* a `position: fixed`
overlay mounted for the duration; the overlay also stops CodeMirror selecting text under the
drag and keeps the `col-resize` cursor across both panes. `85:16932` (`.ht/cursor`) is a drawn
glyph in the frame — the native cursor covers it.

The handle is a `role="separator"` with `tabIndex=0`: ArrowLeft/Right move the seam 2%, `Home`
and double-click restore the designed 50%. Not in the design; a keyboard-only user otherwise has
no way to reach the affordance at all.

Clamped to 20–80% of the body plus a 320px minimum per pane, measured from the drag's own rect.
Nothing re-clamps afterwards — narrow viewports are T9's (open item 19).

Verified live, not only against the empty frame the spec drags over: `?example=react` on the dev
server with Sandpack actually booted and a Handsontable grid rendered inside the cross-origin
iframe. The seam tracked the pointer through it (599 → 798 in four measured steps), dragged back,
left the grid alive and the preview `ready`, selected no editor text, and survived a reload.
The Tier-2 container path was not exercised — it needs Docker and the API worker — but the shell
code is engine-agnostic and the frame is the same element.

---

## T7 — Example picker cascader

**Scope.** Restyle the existing `DocsCascader.tsx` to the design's popover: search input +
category column → grouped example column with section headers (`CONTEXT MENU`,
`DRAG TO SCROLL`, `EMPTY DATA STATE`, …). Behaviour already exists (starters + docs examples,
framework auto-pick via `FW_PREF`) — keep it.

**Files.** `apps/authoring/src/DocsCascader.tsx`, `docs-catalog.ts` (grouping/search helpers).
**Nodes.** `72:17078`.
**Depends.** T0, T1, T2.

**Shipped (DEV-2161).** The depth-driven N+1 column stack is gone; the popover is a fixed two
columns at the pill's own width. `docs-catalog.ts` now owns the model (`buildPickerModel`,
`searchLeaves`) and `DocsCascader.tsx` is presentation — the dead `groupByBreadcrumb` /
`optionLabel` / `DocsGroup` exports left over from the old `<select>` are deleted. Three things
worth knowing:

- **Recipes is promoted into the left column** under a `RECIPES` label (open item 19). That is
  what makes "exactly two columns" possible at all, and it is a deviation from the frame.
- **Keyboard navigation is new**, not restyled — the component had only Escape. Roving `tabindex`
  over both columns: `ArrowDown` from the search field enters the list, `ArrowRight`/`Enter`
  crosses into the examples, `ArrowLeft` returns, `Enter` selects or toggles a section, and the
  walk skips rows inside a collapsed group. The category column is a `listbox`; the example
  column is a **`tree`**, because `listbox` has no valid content model for an expandable header.
- **The section-header chevrons are live**, not decorative (unlike the tab close ✕, item 9) —
  groups collapse. Collapse state resets on close, and opening force-expands the group holding
  the current selection so the highlighted row is never hidden.

T2's `width: "max-content"` on the popover is retired for `width: "100%"`: the design sizes the
popover *to* the pill, so the pill being its containing block — previously the thing that clipped
it — is now exactly what is wanted. `s.topBar`'s `zIndex` still matters and is untouched.
`SectionHeader.tsx` now exports its `headerLabel` type style, which the cascader's group headers
and left-column section labels both reuse.

Three e2e specs bound to the old layout. `docs-examples.spec.ts:227` was the real breakage:
`getByText("Standard example")` matched once when a single guide's examples showed at a time, and
"Standard example" is the commonest title in the manifest — it is now scoped through
`getByRole("group")`, which the a11y markup provides anyway. The `✓` glyph is gone, so the
assertion that a stranded starter isn't selected now reads `aria-selected` instead of row text.
Two specs added: collapse/re-expand, and the keyboard walk.

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

**Shipped (DEV-2162).** `FullEmbed` → `FullMode`: `TopBar` + new `FullBar` + the same static
iframe + `PreviewStatusBar`. `EditorShell.tsx` was not touched — full mode has no workspace, so
it composes the shell's parts directly instead of growing a layout variant inside a component
that binds to a `DemoRuntime`.

**The full-mode bar is three elements, and `PreviewBar` could not be one of them.** `65:20487`
is refresh · URL · `window-minimize` — no version pill, no framework pill, no book, no github.
`PreviewBarProps` requires `version` / `versionOptions` / `onVersionChange` by construction
(T2), so the URL field moved to its own `PreviewUrlField.tsx` (clipboard write, the 1.5s
`copied` window, the ellipsis clamp, disabled-when-empty) and both bars compose it. Widening
`PreviewBar` with optional props would have put full-mode branches inside T2's component for the
one element the two bars share.

**`?mode=full` needs a saved id, and now says so in one place.** It used to be read inside
`App()`'s `share` branch, so `/edit/:id?mode=full` and `/?mode=full` silently fell through to
the full app — and `openFullWindow` stamps the param onto *the current* URL, so
`window-maximize` in `play` opened a duplicate of the app in a new tab. `fullModeId(route)`
answers it per route: `share` and `edit` resolve (both render the build `/share/:id` already
serves publicly — no new exposure), `play` cannot (no id, therefore no `/d/:id/` artifact), and
`onMaximize` is withheld there so the UI can't reach it either.

**The status dot is a `GET` probe, not the iframe's `load` event.** `load` fires for a 404 page
too, and `/d/:id/` exists only if `runBuild` succeeded at fork time, so a demo without a build
would have reported `● ready` over the worker's "Not found" — which the iframe does render, being
the response body. The frame is cross-origin, so it cannot be introspected. `GET`, not `HEAD`:
that route is gated on `request.method === "GET"` (`workers/api/src/index.ts:493`), so a `HEAD`
never reaches `serveDemoAsset` and *every* full-mode view would have read `error`. The HTML entry
is `max-age=0, must-revalidate` and the iframe requests the same URL, so this is one conditional
request, not a second download. 404 (no demo, or no artifact) and 410 (revoked) both fail `ok`.

**Chrome renders on the first paint; metadata fills in behind it.** Share mode blocks on
`Splash` until its source arrives, but here that would delay the demo itself to wait on a pill
title. Instead `FullMode` renders immediately (the iframe starts loading at once — the point of
wrapping the prebuilt artifact) and the title, version and framework label land as their fetches
settle: `/api/demos/:id` for `title` + `ht_version`, `/api/demos/:id/source` for `framework` (→
the catalog's short `React (Vite, TS)`) and the files `Download` zips. `PreviewStatusBar`'s
`version` is required, so it falls back to `DEFAULT_VERSION`; `Download` hides when the source
fetch fails rather than handing over an empty zip. `downloadWorkspaceZip()` is now module-level
in `App.tsx` — full mode has no `filesRef` to close over.

`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"` carried over
unchanged. Refresh re-keys the iframe (`reloadGen`), which re-requests the build *and* re-probes;
minimize is a navigation with the `mode` param deleted, not `window.close()` — `close()` only
works for a window the script opened, so it does nothing on a pasted link.

**No `Sign in` in full mode**, matching the frame: nothing in the view needs auth, and the build
is public. `authed={false}` with no `onSignIn`.

**Theme toggles the chrome only.** The iframe is the prebuilt artifact with its own
`ht-theme-main.min.css` (ADR-0022), so light chrome + dark grid in full mode is correct, the same
mix `65:21451` draws. Nothing to build.

**The full-window share link stopped being bare**, so `ShareLinks.tsx`'s copy changed with it:
that row used to read "example only — embed in any iframe", which is now `/embed/:id`'s job.

Logged-out chrome needed **no code**: see open item 30.

---

## T9 — Apply the design system to existing, undesigned functionality

**Shipped** (DEV-2163). Its premise changed mid-flight: an **After Login** section
(`114:23287`) was added to the Figma file after the subtask was written, and it supplies real
frames for surfaces T9 had been told to invent. So T9 split three ways.

### A — designed after all, built to frame

| Surface | Frame | Landed as |
|---|---|---|
| My Demos **page** | `114:25521` | `apps/authoring/src/MyDemos.tsx`, rewritten from a 340px drawer into a route |
| Account menu | `114:21480` | `packages/editor-shell/src/AccountMenu.tsx`, in `TopBar` |
| Share links dialog | `114:23289` | `apps/authoring/src/ShareLinks.tsx`, rebuilt |
| Edit info dialog | `114:24410` | `apps/authoring/src/EditInfoDialog.tsx` (new) |
| BOX INFO pencil | `114:21684` | `BoxInfo`'s `onEdit`, opening the above |

The card grid, the kebab (Open / Copy link / Fork / Rename / Delete) and the `+ Create` tile are
all from `114:25521` / `114:27012`. Rename routes to `/edit/:id?edit=info` rather than editing in
place: a demo's title and its code are one PATCH, and the Edit info dialog already lives there.
The query param is what keeps Rename from being a second Open — it opens the same page with the
dialog already up.

Two supporting pieces the frames imply but don't draw:

- **`packages/editor-shell/src/Dialog.tsx`** — there was no dialog primitive at all. Both designed
  dialogs are the same 356px card, and neither hand-rolled overlay had `role="dialog"`, a focus
  trap or an Escape handler.
- **Five icons** added to `icons/ui.tsx` per ADR-0024: `IconListDetails`, `IconSettings2`,
  `IconLogin2`, `IconDotsVertical` (all read off layer names) and `IconCopy`.

### B — still undesigned, dev judgment (ADR-0023 rule 1)

- **Error states.** Existing handling kept verbatim — same statuses, same triggers. Only the
  *body* changed: `share.ts`'s 404/410 and `index.ts`'s catch-all were bare `text/plain`, so a
  revoked share link rendered browser-default with no branding. New
  `workers/api/src/error-page.ts` gives document requests a self-contained branded page;
  `/api/*` keeps JSON and a missing hashed asset keeps plain text (`wantsHtmlError`).
- **Favicon / titles / meta.** Resolved by *reuse*, not a new asset: `favicon.png`,
  `favicon-dark.png` and `handsontable-banner-og.png` are copied from
  `handsontable/handsontable@develop`'s `docs/public/`, wired with the same
  `prefers-color-scheme` link pair the documentation site uses
  (`docs/src/components/Head.astro:14-15`). The title is now route-aware — it said
  "Authoring" on public `/share/:id`.
- **Responsive.** Deliberately *not* a breakpoint system; there is no frame to build to. Two
  concrete fixes only: the splitter re-clamp (open item 19) and `auto-fill` card wrapping.
- **Delete confirmation**, **empty state**, **revoked cards**. Confirmed on the ticket: keep a
  confirmation (there was none — `remove()` fired `DELETE` on the first click), keep the empty
  state simple, and keep revoked demos *visible* and muted rather than hidden.

### C — split out

**The Settings page** (`114:26833`) is a new feature, not design-system application: it needs a
profile table, a migration, profile endpoints and avatar storage, none of which exist. Per
ADR-0023 rule 2 it becomes its own task. T9 renders the menu row disabled — which is exactly how
`114:21480` draws it.

### Behaviour changes worth knowing

- **`authedExtras` is now empty.** The title/description inputs and the My demos / identity /
  Log out buttons lived in the unframed authed action bar only because ADR-0023 had nowhere else
  to put them. All of it now has a frame.
- **The top bar keys off `accountEmail`, not `authed`.** `/share/:id` renders the workspace
  anonymous on purpose (read-only, no action bar), and it used to offer a signed-in visitor
  "Sign in". `ShareRoute` resolves the identity for the menu alone, without gating the render.
- **`description` can now be cleared.** `index.ts`'s two PATCH branches coalesced with `??`, so
  `null` restored the old text. Invisible while it was a bare input; obviously broken behind a
  Save button.

**Depends.** T0, T1. Ran in parallel with T2–T7.

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

- ~~**Multi-file tabs.** Tab strip ships styled, single active file. (T4)~~ **Closed by ADR-0025** —
  in scope as **T12**. The ✕ and the unsaved indicator are only meaningful with more than one open file,
  so deferring them meant rebuilding `EditorTabs` twice.
- **Embed theme *handling*.** Still deferred: `72:11913` / `72:13670` are structurally identical and
  differ only in colour, so they read as a light example and a dark example — ADR-0022's position.
  **But the `?theme=` hint the app emitted is dropped** (ADR-0025, open item 44): `share.ts` never read
  it, so it was a URL promising behaviour the server does not have.
- **The Settings page** (`114:26833`). Its own task — new profile table, migration, endpoints, avatar
  storage. See item 33; unchanged by this audit.

## Open items raised during implementation

A running log. Subtasks **append** here rather than resolving inline — the calls get made in one
pass at the end of the redesign, so nothing blocks a subtask from landing. Each item names the
subtask that surfaced it and what evidence exists.

| # | Item | Kind | Raised by |
|---|---|---|---|
| 1 | Dark `textMuted` deviates from the Figma variable | design decision | T0 |
| 2 | ~~`ShareDialog.tsx` is dead code the docs still reference~~ **closed by T9** — deleted, ADR-0022 corrected | cleanup + doc fix | T0 |
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
|  | ↳ **favicon half closed by T9** — reused the docs site's shipped `favicon.png` / `favicon-dark.png`. The *pill* mark is still open. | | |
| 14 | Tier-1 has no preview URL to put in the row-2 address field | design decision | T2 |
| 15 | The version warning has no home in a 36px bar | design decision | T2 |
| 16 | An inline `background` silently kills any stylesheet `:hover` on the same element | gotcha | T3 |
| 17 | A late Sandpack mount could revive a preview the app had stopped | fixed bug | T3 |
| 18 | A child's `useLayoutEffect` runs before an ancestor's `ref` is attached | gotcha | T6 |
| 19 | ~~Nothing re-clamps the split after the drag that set it~~ **closed by T9** — `reclamp()` on a `ResizeObserver` + sidebar toggle | deferred to T9 | T6 |
| 20 | The search placeholder reads `Search examples…`, the design says `Search ...` | design decision | T7 |
| 21 | `Recipes` is promoted to its own left-column section; the design shows it flat | design decision | T7 |
| 22 | `next` carries both `Filtering And Search` and `Filtering Search` | upstream data bug | T7 |
| 23 | Figma `common/colors/accent-color` is `#4669f6`; `theme.ts` ships `#1A42E8` | design decision | T7 |
| 24 | The category column's scrollbar eats into the 179px the design gives labels | design decision | T7 |
| 25 | TypeScript docs examples boot with a `/src/main.js` entry against a `.ts` file | pre-existing bug | T7 |
| 26 | Tier 1 has no refresh-completion signal, and may not recompile at all | open question | T5 |
| 27 | The Handsontable version renders twice in `play` mode | design decision | T5 |
| 28 | `72:14610` draws chrome above a splash that renders before the shell exists | design decision | T5 |
| 29 | `README.md` lists `runner/apps/viewer/`, which does not exist | doc fix | T5 |
| 33 | The Settings page is a new feature, not design-system application | split out | T9 |
| 34 | The design shows no revoked state for a demo card, but the API only ever revokes | design decision | T9 |
| 35 | `/share/:id` now shows a signed-in visitor their account menu instead of `Sign in` | behaviour change | T9 |
| 36 | A `<button>` with no inline `background` gets the UA's `buttonface` slab | gotcha | T9 |
| 37 | No owner display name or avatar exists anywhere in the stack | asset/data gap | T9 |
| 38 | `accent` as link text on a dark surface lands under WCAG AA | design decision | T9 |
| 39 | `114:23289`'s full-window label describes behaviour the app doesn't have | design copy fix | T9 |
| 40 | ~~`Fork` / `Share` / custom version have designed homes — the authed action bar is retired~~ **closed by T10** — the bar is deleted (DEV-2167); raised items 48, 49 | **decided** (ADR-0025) | audit → T10 |
| 41 | ~~Sidebar file CRUD follows **login**, not mode~~ **closed by T11** — the gate is `!!user && !isShare` (DEV-2168) | **decided** (ADR-0025) | audit → T11 |
| 42 | Multi-file tabs move into scope; per-file `dirty` is the data-model change | **decided** (ADR-0025) | audit → T12 |
| 43 | The tab glyph is a dirty dot at rest, the ✕ on hover | **decided** (ADR-0025) | audit → T12 |
| 44 | The embed URL's `?theme=` is inert and gets dropped | **decided** (ADR-0025) | audit → T13 |
| 45 | Frame-index omissions and two stale "not rendered" rows | doc fix | audit → T14 |
| 46 | The designed dialog card is 360px, not 356 | cosmetic | audit → T13 |
| 47 | A signed-in `play` user's added file is lost on an example switch | design decision | T11 |
| 48 | `Download` stays unconditional — the top bar's mode slot holds `Fork` / `Save` only | deviation | T10 |
| 49 | The version pencil sits after the pill's chevron, not before it | deviation | T10 |
| 50 | The preview bar overflows a narrow preview column — pre-existing, and T10 adds 72px to it | design decision | T10 |
| 51 | The open-tab set is not persisted across a reload | deferred | T12 |
| 52 | No `Cmd/Ctrl+W` or `Ctrl+Tab` — both are browser-reserved | deviation | T12 |

Items **40–46** come from the [DEV-2027 Figma gap audit](dev-2027-figma-gap-audit.md), which re-read the
file against the shipped branch after the **After Login** section landed. The audit also **closes three
existing items** — see the resolutions appended to 9, 13 and 27 below.

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

**Closed by the gap audit → T12.** Multi-tab is in scope (ADR-0025), so the ✕ becomes a real control.
Per item 43 the glyph is a **dirty dot at rest and the ✕ on hover**. Note the audit also established
that closing a tab cannot lose edits — contents live in the app's `files` map and `EditorShell` holds
only a view pointer — so no confirmation dialog is needed, only a test.

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

**Resolved by T3 — the asset now exists.** BOX INFO needs the same 20×20 mark (`72:16988`), so
DEV-2157 added `packages/editor-shell/src/mark.svg`, exported as `markUrl` from `useLogoUrl.ts`.
It is package-level precisely so the pill and the favicon can share it. No per-mode variant is
needed: the mark carries its own dark plate, so it reads on either shell surface.

Figma exports this node as a raster fill, not vector, so the SVG was authored from the node's
measured geometry — white-pixel bounding boxes sampled off the 400×400 export, giving the H at
`x 91–249 / y 77–251` with a `39px` crossbar and the period at `x 262–319 / y 265–322` on a
`#0F0F10` plate. Corners are square in the asset; the 2px radius is applied by the consumer, as
the frame does. **Still worth a real asset from design** if brand has an official one — this is
a faithful trace, not the source file. Wiring it into the pill is T2/T9's call, not T3's.

**Neither T2 nor T9 wired it — assigned to T13.** `markUrl` is consumed only by `BoxInfo.tsx`, while
`App.tsx`'s pill still carries T2's comment justifying the omission by an asset gap T3 had already
closed. Every After Login frame draws the mark in the pill. One import, plus deleting the stale comment.

### 14. Tier 1 has no preview URL for the row-2 address field (design decision)

The field shows the demo's public URL when it has one — always `/share/:id`, never `/edit/:id`,
even while editing: the field is click-to-copy and `/edit` is auth-gated behind a broker that
only accepts `@handsontable.com` — else the URL `mount()` reports. Tier 2
gives the container's preview origin. Tier 1 does not: `SandpackRuntime.mount` returns
`this.opts.iframe.src` (`sandpack.ts:195`), which at that moment is Sandpack's *bundler* origin
— `https://…sandpack.codesandbox.io/`. That is both meaningless to the user and a CodeSandbox
mark, which ADR-0001 keeps out of the UI. T2 therefore surfaces the URL only for the container
engine and renders a muted `Live preview` placeholder otherwise.

So an anonymous playground on a Tier-1 starter — the exact case `72:15697` draws with a
`/share/…` URL in the field — shows the placeholder. Options if that reads as empty: drop the
field when there is no URL, or show the browser's own address. Worth one line from design.

### 15. The version warning has no home in a 36px bar (design decision)

`versionWarning` used to sit in the old top bar, which grew with its content, so a long string
simply wrapped. Row 2 is a fixed 36px and both strings run ~90 characters —
"Handsontable X isn't a published build; showing the latest next build (Y) instead." and
"This example has unsaved edits; its content may not match the selected version API." — so the
span now clamps to one line with an ellipsis and keeps the full text in `title`.

That is a compromise: a truncated warning is a warning you can miss, and a `title` tooltip is
not reachable by touch. No frame shows a warning anywhere in section `18.1`, so there is no
designed slot to move it to. Options worth a design call: an ⚠ icon in the bar that opens the
text on click, a transient toast over the preview, or a line in the preview's bottom status bar
(T5) — which the frames do draw, and which has the width.

### 16. An inline `background` silently kills a stylesheet `:hover` (gotcha)

The shell styles components with inline `CSSProperties`, so `:hover`, `:focus-within` and
descendant selectors are unreachable from the package and live in the app's global block
(`apps/authoring/index.html`) — `.hot-casc-row`, `.hot-icon-btn`, and now `.hot-file-row`.

The trap: an inline declaration outranks any stylesheet rule for the same property, **including
`transparent`**. T3's file rows initially set `background: activeRow ? surfaceMuted :
"transparent"` inline, which made `.hot-file-row:hover { background: … }` dead code. It was
caught only because the browser check measured the hovered row's computed background rather than
just confirming the row-actions reveal — and the reveal *did* work, because `opacity` was never
set inline.

Both fills moved into the global block keyed off `data-active`, hover declared last so equal
specificity resolves in its favour. **Applies to T5–T9:** any element that needs a stylesheet
hover must not set that same property inline. Verify by reading `getComputedStyle` under a real
pointer — synthetic `mouseover` events do not trigger CSS `:hover`.

### 17. A late Sandpack mount could revive a stopped preview (fixed bug — T5 owns the surface)

`SandpackRuntime.mount()` awaits `buildSetup` and then `loadSandpackClient`, and the loader
points the iframe at the bundler origin itself. `dispose()` only destroyed `this.client`, which
is still `null` while a mount is in flight — so a mount resolving *after* disposal re-pointed an
iframe the app had already blanked. `ContainerRuntime` always guarded this (`container.ts:360`,
`if (this.pointed)`); Sandpack did not.

This is why blocking a docs preview (`App.tsx`'s `docsRuntimeBlocked` effect: dispose, then
`iframe.src = "about:blank"`) was only *usually* durable. `e2e/docs-examples.spec.ts:297` asserts
it and passed on luck — the mount happened to resolve before the blank. Adding one `<img>` to the
sidebar in T3 reordered it and turned the spec red, which is how the race surfaced.

`dispose()` now sets a flag `mount()` re-checks after both awaits, destroying the late client and
restoring `about:blank` — but only when the instance still owns the iframe. That second half
matters because `dispose()` is *also* called on every ordinary re-mount: the mount effect
disposes the old runtime and immediately mounts a new one on the same frame, so an unconditional
blank would kill the successor's live preview. Each mount claims the frame before its first
await. The ownership half is defensive: reachable by inspection, not reproduced — four manual
dispose/remount cycles missed the window, and a build without the check behaved identically.

Note for T5: the five specs that actually mount Sandpack are `live:`-prefixed and gated behind
`E2E_LIVE=1`. A default `playwright test` run skips every one of them, so a green default run
proves nothing about preview mount/teardown.

### 18. A child's `useLayoutEffect` runs before an ancestor's `ref` is attached (gotcha)

T6's first cut restored the persisted ratio from a `useLayoutEffect` inside `SplitHandle`, writing
`--hot-split` onto `EditorShell`'s body node through the ref it was handed. It silently did
nothing. React commits bottom-up: a descendant's layout effect runs *before* its ancestor's ref
is attached, so `bodyRef.current` was still `null` — and the optional-chained write no-oped
without a symptom. Drags worked (by then the ref was live) and only a reload lost the ratio.

Which is why the value is a plain inline style now: React puts the custom property on the grid in
the first paint, and nothing depends on commit ordering. `useTheme`'s layout effect is *not* a
counterexample — it writes to `document.documentElement`, which exists before React does.

Two lessons for the rest of the redesign. An optional-chained DOM write is an error handler that
never reports; if the node must be there, the failure should be visible. And a persistence bug of
exactly this shape is invisible to a within-page test — `e2e/splitter.spec.ts` caught it only
because it reloads and re-measures.

One trap in that spec worth naming: an `addInitScript` that clears the storage key also runs on
`page.reload()`, so it silently defeats the persistence assertion it was meant to isolate. Each
test already gets a fresh context; no reset is needed.

### 19. Nothing re-clamps the split after the drag that set it (deferred to T9)

The 320px-per-pane minimum is enforced from the rect a drag measures, so a *drag* can never
starve a pane. Two later events can, because the fraction is held fixed and nothing re-runs the
clamp: shrinking the window (at a narrow enough width, 20% of the body is under 320px), and
**opening the sidebar** after dragging wide with it collapsed — the editor loses 240px it was
never re-measured for. No `ResizeObserver`, deliberately: T9 owns narrow viewports, and there is
no breakpoint frame anywhere in section `18.1` to clamp toward.

### 20. Search placeholder is `Search examples…`, not the design's `Search ...` (design decision)

`72:18031` labels the cascader's search field `Search ...`. The field kept its existing
`Search examples…`: it is also the input's accessible name, where "examples" is the word that
says *what* is being searched, and three specs bind to it. Trivially changed if design wants the
shorter string — but then `aria-label` should keep the longer one.

### 21. `Recipes` is promoted to its own left-column section (design decision)

The design (`72:18037`) draws one flat column of 15 categories, `Recipies` among them. The
manifest does not fit that shape: 152 examples carry a **three**-segment breadcrumb, all under
`Recipes` (`["Recipes", "Cell Types", "Star Rating"]`), against 1,250 at two segments and 50 at
one. A flat `Recipes` row would need a third column for those 152 — which breaks the popover's
fixed 480px, the one width the design is explicit about.

Shipped instead: the left column carries section labels, and Recipes' 12 sub-categories are
promoted to first-level rows beneath a `RECIPES` label, so every category resolves to exactly one
level of section headers. Two consequences a reviewer should know about:

- Four Recipes sub-categories (`Accessibility`, `Cell Types`, `Context Menu`, `Data Management`)
  share a name with a documentation category. Keys are namespaced (`Recipes|Cell Types`); the
  section label is the only *visual* disambiguator.
- 16 documentation categories + 12 Recipes + starters is ~920px of rows against the design's
  512px column, so the category column scrolls. The design shows no scrollbar.

Also note the design's `Optimilzation` and `Recipies` are Figma typos — the manifest values are
`Optimization` and `Recipes`, and the shipped UI uses those.

### 22. `next` carries both `Filtering And Search` and `Filtering Search` (upstream data bug)

The `next` bucket has two Recipes sub-categories that are plainly the same thing — `Filtering And
Search` (2 guides) and `Filtering Search` (1). Invisible while Recipes was one collapsed row;
promoting its sub-categories to the left column puts them side by side.

Rendered verbatim rather than normalised in the picker: merging them client-side would hide a
docs-repo inconsistency the importer faithfully reproduces, and the fix belongs upstream in the
guide's directory naming. `18.0` is unaffected.

### 23. Figma `common/colors/accent-color` is `#4669f6`, `theme.ts` is `#1A42E8` (design decision)

`get_variable_defs` on the cascader popover returns `common/colors/accent-color: #4669f6`, while
`theme.ts` ships `#1A42E8` (read off frames `48:6560` / `31:6438` in T0). Not acted on: `theme.ts`
is the single source of branding tokens by its own charter, and changing `accent` would repaint
every surface in the app, not just this popover. Logged so the two get reconciled in one pass —
same shape as item 1.

### 24. The category column's scrollbar eats into the 179px the design gives labels (design decision)

`72:18037` is a 179px column showing 16 categories with no scrollbar, and `Accessories and Menus`
fits its 143px text area. The live manifest has 28 categories, so the column must scroll — and a
classic scrollbar (Windows/Linux always; macOS when "always show scrollbars" is on) takes ~15px
out of that 179, at which point the label renders `Accessories And …`.

Mitigated, not solved: `scrollbarWidth: "thin"` recovers most of the track, and every row carries
a `title` with its full label. `scrollbar-gutter: stable` is *not* the fix — it reserves the track
unconditionally, so the content box stays narrow either way. A real fix means either a wider
popover than the design's 480px or shorter category labels; both are design calls.

### 25. TypeScript docs examples boot with a `/src/main.js` entry (pre-existing bug — not T7)

Found while confirming T7's `FW_PREF` fallback: from a React example, picking `Accessibility ▸
Standard example` (which has no React variant) correctly resolves to the TypeScript variant, and
then the preview fails with

```
ModuleNotFoundError: Could not find module in path: '../index.ts' relative to '/src/main.js'
```

The sidebar shows `src/main.ts` and `index.ts`, so the files are right and the *entry* is wrong.
**Not caused by the picker** — the identical error reproduces on a direct
`?docs=guides/accessibility/accessibility/javascript/example1.ts` load with no picker interaction,
so `FW_PREF` and T7 are both exonerated. Note the manifest puts TypeScript variants under a
`javascript/` directory with a `.ts` extension, which is the likely trigger.

Same shape as the `.jsx`-vs-`main.tsx` mismatch tracked under DEV-2130. Left alone: nothing about
it is chrome, and fixing entry resolution inside a restyle PR would bury it.
### 26. Tier 1 has no refresh-completion signal, and may not recompile at all (open question)

T5 first built the Tier-1 refresh promise to settle on the bundler's next `done`, reasoning
that `reload()` → `pushUpdate(true)` → `updateSandbox(setup, true)` triggers a compile that
reports back. **It does not.** Measured in a browser: after a refresh click the parent window
sees **no messages at all** for the following 11 seconds, while a `done` on mount arrives
normally and drives `emitReady()` — so the listener is fine and it is this specific call that
goes unanswered. The promise therefore never resolved early and always rode its 10s timeout
out: the shell blanked the pane and held a spinner over it for a full 10s on **every** Tier-1
refresh.

Shipped instead: `SandpackRuntime.reload()` settles on its own transpile + dispatch, which is
work we actually perform and can time (measured 48–62ms on a warm React starter, three
consecutive runs, no timeouts). The promise means "your update has been handed to the bundler",
and the timeout, the waiter set and the `settleReload()` hook are all gone with it. Tier 2 is
unaffected — a container re-navigates the iframe, so its `load` is a real completion event.

**The open question is what `updateSandbox(setup, true)` does with an unchanged file set.** If
it no-ops, the Tier-1 refresh button does nothing at all, and the silence is the symptom rather
than the bug — which would make T2's "`isInitializationCompile` re-runs the sandbox" claim
wrong. Not chased here: it predates T5, the button is T2's, and settling this needs a look at
the bundler protocol rather than at chrome. Worth its own ticket.

Two things a follow-up should not re-derive. Arming the `done` listener *after* dispatch does
not help: the transpile is awaited first, so the resulting message can land in the same turn
the dispatch promise resolves, and arming late loses that race — measured 10.07s to clear.
And giving refresh its own sequence number instead of sharing `updateSeq` with `writeFile` is
worse: the two would race to publish, and a refresh that won would put pre-keystroke output
over a newer edit, which is exactly what the shared guard exists to prevent.

### 27. The Handsontable version renders twice in `play` mode (design decision)

`PreviewBar`'s row-2 `MenuButton` renders `Handsontable` + `{version}` and the new bottom bar
renders `Handsontable {version}` again, so a playground shows the version in two places about
700px apart. No frame shows the collision: `48:6560` is a *saved demo*, which has no version
menu, and it is the only frame that draws the bottom bar's right-hand group.

Both are defensible on their own — the menu is the control, the bar is the readout — and the
design asks for each. Needs a call on which one survives in `play`. Note the bar is also the
only version readout in T8's `?mode=full`, which has no row 2, so deleting it there is not an
option.

**CLOSED by the gap audit — keep both.** The premise above ("no frame shows the collision") is a
measurement error. **Five frames draw the version in the row-2 pill and the bottom status bar at once:**
`72:15697`, `72:17078`, `114:21146`, `114:23289`, `114:24410`. The first two are in the **Before Login**
section and predate the After Login frames, so this was answerable when the item was written. The
duplication is intended, exactly as the paragraph above guessed — the menu is the control, the bar is the
readout. No design call, no code change.

### 28. `72:14610` draws chrome above a splash that has no chrome to draw (design decision)

The loading frame shows the top bar — logo, search pill, theme toggle, Sign in — above the
centred spinner. `Splash` cannot: it renders *because* the user, example or saved demo has not
resolved yet, so there is nothing to fill a top bar with. T5 ships the spinner and the copy and
skips the chrome.

Two readings: the frame is a composite (chrome drawn for context, not specified for this
state), or the app should render a real skeleton top bar during load. The second is a bigger
change than a splash — it needs the shell's chrome to render against absent state.

### 29. `README.md` lists `runner/apps/viewer/`, which does not exist (doc fix)

`runner/README.md`'s package table names `runner/apps/viewer/` as a "public read-only `/d/:id`
viewer". `runner/apps/` contains only `authoring/`, and `/d/:id` is served by the Worker from
prebuilt R2 artifacts (`workers/api/src/share.ts`) with no app involved — which ADR-0020 and
T8's scope both already say. The table row is stale; nothing is missing.

### 30. `72:15697` gives the anonymous view `Sign in` alone, no `Download` (design decision)

The frame's top-right group (`72:15867`) is theme toggle + `Sign in`, 127px — no `Download`. The
app passes `onDownload` unconditionally (`App.tsx`), so an anonymous visitor sees both, in `play`
as well as `share`.

T8 kept both, per ADR-0023 rule 1: `Download` works for anonymous visitors today and a frame
omitting it is not an instruction to remove it. Worth noting the button is not the only way out
either — the sidebar's FILES header carries the same zip in every mode — so hiding it would cost
little if design wants the frame followed exactly. One-line change either way
(`onDownload={user ? downloadZip : undefined}`), which is why it is logged rather than guessed.

Related: `72:15697` is the anonymous **`play`** view, not an anonymous share view — its pill
holds the cascader and `tabler-icon-search` (`72:15865`). `TopBar.tsx`'s comment predates that
reading and says no frame shows an anonymous view at all; the share half of that is still true.

### 31. Full mode needs the SPA and the worker on one origin, which plain `vite dev` isn't (dev-env note)

`serveDemoAsset` sends `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` for `/d/:id`
(`share.ts`) and is *not* wrapped in `cors()`. Production is fine — `.env.production` points
`VITE_API_BASE` at `https://demos.handsontable.com`, the same origin the SPA is served from — so
the iframe frames and the status probe is a same-origin `fetch`.

Locally the default setup is not that: the app runs on Vite's port and the worker on 8787, so the
iframe is refused *and* the probe fails CORS, which reads as `● error` on a demo that is fine.
The iframe half predates T8 (`FullEmbed` had it); the probe half is new.

Verified by giving the dev server a proxy for `/api`, `/d` and `/embed` and pointing
`VITE_API_BASE` back at the dev server's own origin — which reproduces production's topology.
Worth folding into `vite.config.ts` as a dev-only proxy so `pnpm dev` matches production; not done
here because it changes every local request path, not just full mode's.

### 32. `pnpm typecheck` needs a `pnpm build` first on this branch (build-order note)

`apps/authoring` typechecks against `packages/runtime/dist`, not its source, and that `dist` was
built before T5 added `reload()` to `DemoRuntime`. On a fresh clone of the integration branch
`pnpm typecheck` therefore fails with `Property 'reload' does not exist on type 'DemoRuntime'`
until `pnpm build` regenerates the declarations. Predates T8; the fix is either committing to
build in CI before typechecking or pointing the app's path mapping at the package source, which
is what the `editor-shell` alias in `vite.config.ts` already does for the shell.

### 33. The Settings page is a new feature, not design-system application (split out)

`114:26833` draws a profile page — Name, Description, avatar Upload / Remove. Nothing behind it
exists: the database has exactly two tables (`demos`, `build_cache`), there is no `/api/me`, and
identity is a bare `@handsontable.com` email denormalised into `demos.created_by`. Building it
means a new table, a migration, profile `GET`/`PATCH`, and avatar upload to R2 with the
validation that implies.

Per ADR-0023 rule 2 (a *new* design element is decided per item — build now, or split and record
the gap) this is split into its own task. T9 ships the menu row disabled, which is how
`114:21480` draws it — the design itself reads it as later work.

### 34. No revoked state for a demo card (design decision)

`DELETE /api/demos/:id` has never hard-deleted. It sets `revoked=1`; the row survives, `/d/:id`
starts answering 410, and there is no unrevoke. Every card in `114:25521` is live — the design
has no muted, disabled or archived variant, and no frame for the delete confirmation either.

Confirmed on DEV-2163: **keep revoke, keep the card visible.** Revoked cards render at
`opacity: 0.55` with a `danger`-bordered badge, and carry **no kebab at all**. Every action needs
something the revoke took away: `getDemoSource` returns null once `revoked` is set
(`share.ts`), so Open *and* Rename both land the edit page on "This demo is unavailable."; Copy
link hands out a URL that 410s; Fork has no source to read; Delete already happened. An earlier
cut kept Rename, which was a dead end — a menu of dead ends is worse than no menu.

A hard-delete endpoint was considered and rejected: `forked_from` stores demo ids, R2 artifacts
are never cleaned up, and already-revoked rows would need a migration story. That is a data
lifecycle decision, not a redesign one.

### 35. `/share/:id` shows a signed-in visitor their account menu (behaviour change)

`App.tsx` hardcodes `user={null}` on the share route, correctly — the page is public and
read-only. Before T9 the top bar keyed off the same value, so a signed-in user opening a
colleague's share link was offered **Sign in** while holding a live session.

`ShareRoute` now resolves the identity separately and passes it as `accountEmail`, which is what
the top bar keys off; `authed` still gates the action bar and stays `false`. The identity is
never a render gate, so the page paints exactly as fast as before.

**The resolve has three states, not two** (caught in review). `currentUser()` round-trips the
external broker, so seeding `accountUser` as `null` meant "anonymous, confirmed" for a few
hundred milliseconds and the bar offered a signed-in visitor a working **Sign in** — the exact
thing the split removes, just briefly. `undefined` is now pending, and `accountPending` withholds
`onSignIn`, so the window renders neither control rather than the wrong one.

Worth knowing when testing this by hand: `apps/authoring/.env.local` sets `VITE_DEV_USER`, which
short-circuits `currentUser()` before the fetch. Any test of the broker path has to override it
(`VITE_DEV_USER= pnpm dev`) or it silently exercises the bypass instead.

### 36. A `<button>` with no inline `background` gets the UA's `buttonface` (gotcha)

The corollary to item 16, and it bit three times during T9. Item 16 says an inline `background`
outranks a stylesheet `:hover`, so a hoverable button must not set one — but omitting it
entirely falls through to the user-agent default, which paints a light-grey slab in *both*
modes. Caught on the My Demos nav, where "Log out" read as the selected row.

The fix is the one `.hot-file-row` already used: put **both** fills in the stylesheet, base first
and `:hover` second. Equal specificity, source order decides. A button that is genuinely never
hovered — a disabled row — can keep an inline `background: "transparent"` instead.

**Item 16 is not only about `background`.** Review of T9 found two more inline properties killing
their own hover, and both are easy to miss:

- **`color`.** The kebab's Delete row inverts to white-on-red; an inline `color: danger` left red
  text on the red fill. Any property the hover changes has to stay out of the inline object.
- **The `border` shorthand.** `.hot-demo-card:hover { border-color: … }` was dead because the
  card set `border: 1px solid …` inline — the shorthand carries `border-color`, so it wins even
  though the rule names only the longhand.

Verify these the way the item says: a real pointer plus `getComputedStyle`, comparing rest
against hover. A synthetic `mouseover` doesn't fire CSS `:hover`, and eyeballing a screenshot
can't tell a subtle live hover from a dead one.

**One correction to that procedure, found in T12 — it produces a false negative.** These
elements also carry `transition: background-color 0.12s ease`, and `getComputedStyle` returns
the *currently animating* value, not the target. Read immediately after `hover()`, a perfectly
live rollover reports its resting colour — T12 measured `rgba(0, 0, 0, 0)` on a tab whose hover
works, then `rgba(120, 130, 150, 0.008)` on the retry: `--hot-color-hover` at 5% of the way
through its own transition. **Wait out the transition before reading**, and move the pointer off
the element before reading the *resting* value, or the hover fill masks it. Properties with no
transition (the `display` swap on T12's tab glyphs) can be read immediately.

### 37. No owner display name or avatar exists anywhere (asset/data gap)

`114:25521`'s card footer and `114:21480`'s trigger both draw a round avatar with a name. The
data for neither exists. `auth.ts` types `User` as `{ email, sub?, exp? }`; the API's
`publicView` strips `created_by`; there is no profile table.

T9 renders a monogram from the email's first letter, and the local part where the design wants a
name. It takes no dependency on the external login broker returning `name`/`picture` — the
broker is Google-backed and plausibly does, but this repo has never read or typed them, and that
cannot be confirmed from a code read. Worth one live call to `/broker/userinfo` before item 33
is scoped: if the payload carries them, the profile table gets smaller.

### 38. `accent` as link text on a dark surface is under AA (design decision)

`error-page.ts` briefly shipped dark `accent` as `#4669F6`. That is dark **`splitterActive`** — a
different token that happens to be a lifted blue — not `accent`, which `theme.ts` holds at
`#1A42E8` in *both* modes because it is the brand colour. Caught in review; the file now mirrors
`theme.ts`, which is what its header promises.

Mirroring it faithfully surfaces something pre-existing, though: `#1A42E8` on the dark card
`#222222` is about **2.3:1**, well under WCAG AA's 4.5:1 for body text. The lifted `#4669F6`
would have been ~3.5:1 — better, still short, and wrong by name.

This is not the error page's problem to solve unilaterally: the shell already renders
`accent`-coloured text on dark surfaces elsewhere, so a fix belongs in `theme.ts` as a
dark-mode-only `accentText` (or a lift to `accentHover`'s `#3b5cf0`) applied everywhere at once.
Flag at design review alongside item 1, which lifted dark `textMuted` for exactly this reason.

### 39. The share dialog's full-window label describes behaviour we don't have (design copy fix)

`114:23289` labels the middle row **"Full-window (example only — embed in any iframe)"**. Both
halves are false as shipped:

- **"example only"** — `?mode=full` stopped being bare in T8. It carries the design's own chrome:
  top bar, URL bar, status bar. The chrome-less surface is the docs embed on the row below.
- **"embed in any iframe"** — it cannot be embedded at all. The page iframes `/d/:id/`, which
  sends `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` (`share.ts`). A third-party
  ancestor puts itself in the chain, so `'self'` fails and the inner demo is blocked.

Copying it verbatim would have pointed anyone wanting a bare embed at the one URL that can't do
it, which is worse than a frame going unimplemented. ADR-0023 rule 1 is about not *deleting*
working functionality for want of a frame; it does not oblige us to ship copy that contradicts
the code. T9 ships "Full-window (the demo without the editor)".

**Confirm the wording with design.** The intent behind the frame's copy may be a request — a
genuinely embeddable chrome-less full-window URL — rather than a description of today. If so
that is a feature, not a label.

### 47. A signed-in `play` user's added file is lost on an example switch (design decision)

T11 gave `play` the file CRUD controls, and a `play` workspace is not persisted: `files` is replaced
wholesale whenever the cascader picks another example or another framework (`mountGen` remounts the
runtime), and nothing warns first. The same is already true of *content* edits, so this is
pre-existing in kind — T11 extends it to the file set, where the loss is more visible because the
sidebar row the user created disappears.

Not fixed here: the honest fixes are a dirty-guard prompt on switching or a per-example draft store,
and both are features rather than design-system application. `Download` and `Fork` both capture the
current workspace, so nothing is unrecoverable if you notice in time.

### 48. `Download` stays unconditional — the mode slot holds `Fork` / `Save` only (deviation)

ADR-0025 places `Save` in "the same mode-keyed top-right slot that holds `Fork` when the demo is not
yours and `Download` when it is". That rule was *inferred* from A2's frames, and the code does not
work that way: `TopBar.tsx` renders `Download` whenever `onDownload` is set, deliberately, because
ADR-0023 rule 1 keeps it for anonymous visitors who have always had it (item 30). Implementing the
ADR's wording literally would **remove `Download` in `play`** — a behaviour regression dressed as a
restyle.

T10 therefore splits the difference: a new mode slot left of the theme toggle carries `Fork` in
`play` and `Save` in `edit`, and `Download` keeps its own place to the toggle's right. A2's measured
group — `Fork` 49 · theme 36 · avatar 36 — backs the placement; the frames simply never drew a
signed-in `Download`, which is omission, not removal.

### 49. The version pencil sits after the pill's chevron, not before it (deviation)

`114:24396` draws `tabler-icon-pencil` inside the version pill's frame, adjoining the chevron. It
ships immediately *after* the pill instead. `MenuButton`'s chevron is the last child of the trigger
`<button>` whose only job is toggling the listbox, so a pencil rendered before it would be a nested
interactive that opens the menu on click — the one thing it must not do.

The visual cost is nil: `s.menuButton` sets `border: none` / `background: transparent`, so the pill
has no box at rest for the pencil to fall outside of, only a hover fill. Worth revisiting only if
the pill ever gains a border. A4 is medium confidence anyway — 1 of 5 pills in the file carry the
glyph — so restructuring `MenuButton` around it would be the wrong weight of response.

### 50. The preview bar overflows a narrow preview column (design decision)

`s.bar` is a fixed 36px row of `flex: 0 0 auto` controls with one flexible child (`PreviewUrlField`).
Once that child has collapsed to zero, anything further spills out of the column. Measured in the
browser at the splitter's own minimum (`MIN_PANE = 320`, `SplitPane.tsx:29`), on a bar carrying the
docs-example set — refresh, URL, version pill, framework pill, book, github:

| | overflow at a 320px preview column |
|---|---|
| before T10 | **140px** |
| after T10 | **212px** |

So this is **pre-existing** — the bar was already over-subscribed at the narrow end, which is what
the `versionWarning` clamp at `PreviewBar.tsx:89-93` was working around — and T10 adds exactly the
72px of its two new 36px controls. A starter, which carries no framework pill or book link, still
fits: 312px of fixed content against the 320px floor.

Not fixed here because every fix is a design call, not a restyle: let the version pill shrink and
ellipsize, collapse the right icon group into an overflow kebab past a threshold, or raise
`MIN_PANE`. The frames budget no room for any of it — they draw the bar at one width only. Worth
taking with items 1/6/23/38 in the single design conversation those already want.

### 51. The open-tab set is not persisted across a reload (deferred)

Undesigned — no frame shows a returning session — so ADR-0023 rule 1 applies. T12 reopens the entry
file alone on load, which is what the app did before it. Persisting the set means choosing a scope
(per demo? per example? per browser?) and a home (`localStorage`, or the saved demo row), and the
`play` playground has no identity to key it by. Deliberately left until someone asks for it.

### 52. No `Cmd/Ctrl+W` or `Ctrl+Tab` on the tab strip (deviation)

The two shortcuts the frames imply by drawing tabs at all, and both are browser-reserved: Chrome
closes the browser tab on `Cmd/Ctrl+W` and cycles browser tabs on `Ctrl+Tab`, neither of which a page
can intercept. Hijacking the first would also be actively hostile — a user who means to close the
browser tab and loses a keystroke to the editor has no way to tell what happened.

What T12 ships instead is reachable and unreserved: a roving `tabindex` across the strip with
Left/Right/Home/End, Enter or Space to activate, and Delete/Backspace to close the focused tab.

## Remaining decisions

~~One item to confirm with design during review: whether `edit` mode keeps the file `+` / ✎ / ✕
controls (T3) — no frame shows them anywhere, so the plan reads that from sticky `72:14532`'s
wording.~~ **Answered** — `114:21146` and its three siblings show `+` and `folder-plus` unhidden, and
sticky `114:26599` states the rule. See item 41 / ADR-0025.

Open after the gap audit:

1. ~~**Where `Save` goes** (item 40 / T10). The only authed action with no frame. Recommended: the
   mode-keyed top-right slot that already holds `Fork` when the demo is not yours and `Download` when it
   is, plus `Cmd/Ctrl+S`.~~ **Answered and shipped by T10** — the recommendation was taken, with the
   `Download` half of it declined (item 48). `Save` is the `edit` face of a new top-bar mode slot whose
   `play` face is `Fork`, and `Cmd/Ctrl+S` is wired. Still the one placement wanting design sign-off at
   review, since no frame shows it.
2. **The colour reconciliation cluster — items 1, 6, 23, 38.** Dark `textMuted`; the ramp's four steps
   against three painted surfaces; Figma `accent-color` `#4669f6` vs shipped `#1A42E8`; accent-on-dark
   under WCAG AA. Each item says a single design call fixes it — they want **one conversation, not four**.
3. **Item 37's broker check.** One live call to `/broker/userinfo`: if it returns `name` / `picture`, the
   avatar gap closes without a profile table and item 33 (Settings) gets materially smaller. Worth doing
   before Settings is scoped.

Lower-confidence readings worth one line from design, none blocking: item 4 (two file rows drawn with the
`ejs` icon), item 10 (the active tab's left border), item 20 (`Search ...` placeholder), and item 43's
dirty dot, which appears in exactly one frame.

*Resolved:* theme drives the whole app, embed handling out of scope (T0) · `/d/:id` +
`/embed/:id` dropped (T8) · framework select is a restyle of existing docs-example buttons,
starters unaffected (T2) · ~~authed actions get their own bar in the right panel above the
preview, signed-in only (T2)~~ **bar retired, ADR-0025** · boot log stays (T5) · ~~tabs styled but
single-file (T4)~~ **multi-tab in scope, ADR-0025** · ~~file CRUD gated to `edit` mode (T3)~~ **gated on
sign-in, ADR-0025** · undesigned surfaces get the design system, not deletion (T9) ·
integration branch + sub-PRs, single deploy · version shown in both the pill and the status bar is
intended (item 27) · the embed `?theme=` hint is dropped (item 44).

## Follow-up subtasks T10–T14

The gap audit's work, grouped by topic. Full scope, evidence and file lists in
[`dev-2027-figma-gap-audit.md`](dev-2027-figma-gap-audit.md).

| # | Subtask | Covers | Size |
|---|---|---|---|
| **T10** | ~~Authed action surfaces — retire the unframed bar~~ **landed** (DEV-2167) — raised items 48, 49 | items 40, 46 | M |
| **T11** | ~~Sidebar file CRUD follows login, not mode~~ **landed** (DEV-2168) — raised item 47 | item 41 | S |
| **T12** | Editor tabs — multi-file tabs + unsaved indicator | items 42, 43, closes 9 | M |
| **T13** | Small fixes — pill mark, dialog width, inert `?theme=` | items 13, 44, 46 | XS |
| **T14** | Documentation corrections | item 45 | XS |

T11–T14 are independent. **T10 should follow T11** — both touch the same region of `App.tsx`. T10 and
T12 are the two substantial ones and parallelise (chrome around the panes vs inside the editor pane),
overlapping only on `dirty`: T10 deletes the component that consumes it, T12 splits it per file. Agree
the per-file dirty shape before either starts.
