# DEV-2027 — Figma ↔ implementation gap audit

Branch: `feat/DEV-2027-redesign` · Design: [Figma Sandbox](https://www.figma.com/design/KCl2Csh9WUSwCrddffnYuD/Sandbox) (fileKey `KCl2Csh9WUSwCrddffnYuD`)
Companion to [`dev-2027-redesign-plan.md`](dev-2027-redesign-plan.md), whose 39 open items are treated
here as established fact. **This document covers only the delta** — what those items do not cover, or
cover with a rationale that newer Figma content has since falsified.

Nothing here is implemented. Every finding names the node it came from and the code it contradicts.

## Why there is a delta at all

The plan records that the **After Login** section (`114:*`) was added to the file *after* the subtasks
were written, and that T9 re-derived its scope against it. **T2–T8 were never re-audited against it.**
That is where nearly everything below comes from.

The plan's frame index is missing three nodes and two sticky notes:

| Node | Name | Status in the plan |
|---|---|---|
| `114:21146` | After Login Example — **full authed workspace** | absent; only its descendant `114:21684` is cited |
| `65:23282` | Light mode / Light example (sidebar collapsed) | absent |
| `114:26599` | sticky — "CRUD w sidebar po zalogowaniu" | absent |
| `114:26732` | sticky — "Ta strefa w przyszlosci moze sie rozrosnac…" | absent |
| `65:24280`, `65:17596` | marked *"not rendered — name-inferred"* | both render fully |

`114:21146` is the important one. It is a complete signed-in workspace frame, and four sibling frames
(`114:21480` Menu, `114:23289` Share links, `114:24410` Sandbox info edit) repeat its chrome. Findings
A2–A6 all come out of that group, and each was checked across all four rather than read off one frame.

---

# A. Unlogged gaps

## A1. Sidebar file CRUD is gated on **auth** in the design, on **mode** in the code

The single highest-impact finding, and it closes the plan's only stated "Remaining decision"
(*"whether `edit` mode keeps the file `+` / ✎ / ✕ controls — no frame shows them anywhere"*).

A frame does now. The `hidden` flag on `tabler-icon-folder-plus` / `tabler-icon-plus` in the FILES
section header is perfectly bimodal across the file:

| Section | Frames | `folder-plus` / `plus` |
|---|---|---|
| Fork preview + Before Login | `31:6438`, `48:6560`, `65:17596`, `65:21451`, `72:26445`, `85:9970`, `85:16935` | **hidden in all 7** |
| After Login | `114:21146`, `114:21480`, `114:23289`, `114:24410` | **visible in all 4** |

Sticky `114:26599` states the rule in words: **"CRUD w sidebar po zalogowaniu"** — *CRUD in the sidebar
after logging in*. Confirmed visually on `114:21146`: `+`, `folder-plus` and the download icon all
render in the FILES header, and pencil/trash appear on the hovered row.

The code gates on mode instead (`apps/authoring/src/App.tsx:1192-1194`):

```
onAddFile={route.mode === "edit" ? addFile : undefined}
```

Divergence is confined to one cell, but it is the common one:

| | anonymous | signed in |
|---|---|---|
| `play` (docs example / playground) | no CRUD — **match** | design: CRUD · code: **none** ← gap |
| `edit` (your saved demo) | n/a | CRUD — **match** |
| `share` (read-only public) | no CRUD — **match** | **no frame** — see below |

The `share` row cannot be read off the design. Every After Login frame shows
`demos.handsontable.com/share/…` in the preview bar, but per logged item 14 that field is *always* the
`/share/:id` link — even in `edit` — so it does not identify the mode. The design's only axis is Before
/ After Login; **it never models ownership**, and no frame depicts a signed-in visitor on someone
else's demo. That cell is an open question, not a divergence.

**The apparent conflict with sticky `72:14532`** ("brak opcji na zmiane nazwy / usuwanie / dodawanie
plików w sidebar w trybie fork/view") resolves cleanly if *fork/view* means *not signed in* — which is
exactly how the frame distribution splits, since every fork/view frame lives in the Before Login half.
The plan read "fork/view" as the shell's `play` + `share` modes, which was a reasonable reading of the
wording in isolation and is the reading the new sticky overrides.

**Recommendation.** Confirm with design, then move the gate from `route.mode === "edit"` to signed-in.
Keep `share` excluded regardless — a public read-only page is not the sticky's subject and letting a
visitor mutate someone else's file set is a behaviour change, not a restyle. The honest question for
design is only `play`.

## A2. `Fork` belongs in the top bar

`Fork` is a text button in the top-right group, immediately left of the theme toggle and avatar, in
**4 of 4** After Login workspace frames — `114:24402`, `114:24405`, `114:24408`, `114:24459`. The group
is 137px: `Fork` (49) · theme (36) · avatar (36).

Code puts it in `AuthedActionBar` as a primary button above the preview
(`packages/editor-shell/src/AuthedActionBar.tsx:93-101`).

Worth noting alongside open item 30: these frames show **no `Download`** — `Fork` occupies that slot.
But `48:6560` and `65:24280` (saved demo, full mode) *do* draw `Download`, so the rule is not "Fork
replaced Download" — it is **`Fork` where the demo isn't yours, `Download` where it is**. The authed
top-right now has frames, where item 30 could only reason about the anonymous one; item 30 is
therefore better informed, not resolved.

## A3. `Share` is an icon in the preview bar

`tabler-icon-share` sits at the head of the preview bar's right-hand icon group — before `book`,
`brand-github` and `window-maximize` — in `114:21146`, `114:23289` and `114:24410`.

`PreviewBar.tsx` has no share control. Share is a primary button in `AuthedActionBar`, and only in
`edit` mode.

## A4. The custom-version input has a designed affordance

`tabler-icon-pencil` (`114:24396`) adjoins the version pill's chevron in `114:21146`, and the pill's
frame is widened from 161px to 181px to fit it — a deliberate edit, not a stray paste.

Only 1 of 5 version pills in the file has it, so treat this as **medium confidence** and worth one line
from design. Code ships a 260px text input in the action bar (`AuthedActionBar.tsx:47-59`).

## A5. → ADR-0023's authed action bar has lost its premise

A2, A3 and A4 matter most in combination. `AuthedActionBar.tsx:1-7` opens:

> *"Nothing here appears in any frame: Save/Share (edit), Embed/Fork (play), the custom-version
> input…"*

`App.tsx:1253-1254` repeats it. Both are now false for three of the six affordances, and T9 already
emptied `authedExtras`. What remains in the unframed bar is:

| Affordance | Designed home |
|---|---|
| Fork | top bar (A2) |
| Share | preview bar (A3) |
| custom version | version-pill pencil (A4) |
| **Save** | no frame — but see A6, the tab dirty dot implies one |
| **Embed** | no frame |

One thing the relayout has to solve, and it is easy to miss until you are mid-way through it: the bar
also carries the **in-flight states** — `saving` / `sharing` / `embedding` / `dirty` — and their button
labels (`Saving…`, `Creating…`, `Preparing…`, `Save •`). A 36px icon button in the preview bar has
nowhere to put "Creating…", so whoever picks this up needs a pending/disabled treatment for the icon
form before Fork and Share can move.

So the bar is two controls away from deletable. Removing it would make the **signed-in** view match the
frames exactly — which is the goal ADR-0023 set itself and, at the time, could not reach because the
authed frames did not exist. That is the single largest structural realignment available on this branch,
and it is a relayout of existing working controls, not new behaviour.

## A6. Unsaved-changes dot on the active tab

`114:21146`'s active `index.ts` tab carries `tabler-icon-circle` (`114:26604`) where every other tab in
the file carries `tabler-icon-x`. Visually confirmed: a filled dot on the active tab, ✕ on `index.html`.

**One occurrence file-wide, so low confidence on its own** — but the app already tracks real `dirty`
state (`AuthedActionBar` renders `Save •` from it), so it is both implementable and meaningful, and the
editor idiom it matches is universal.

This is adjacent to logged item 9 but is a *different* claim. Item 9 says the ✕ is decorative until
multi-tab lands. This says the design replaces the ✕ with a modified-indicator on the active tab —
which would give that glyph a job today, with no multi-tab prerequisite.

---

# B. Logged, but the stated rationale is now stale

These already have open-item numbers. Only the *reason recorded against them* needs revisiting.

- **Item 13 — the example pill's 20×20 mark.** The item is annotated "Resolved by T3 — the asset now
  exists" (`packages/editor-shell/src/mark.svg`, exported as `markUrl`), yet `markUrl` is consumed only
  by `BoxInfo.tsx:66`. `App.tsx:1217-1220` still carries T2's comment explaining that the pill ships
  without a mark *because the repo only has the wordmark*. That justification expired when T3 landed the
  asset. Cheapest real fix on this list. **Closed by T13** (DEV-2170) — but note this bullet's original
  claim that "every After Login frame draws the mark in the pill" is **false**: `114:26625` ("My Demos")
  draws none, so the mark went to 3 of the 4 pill sites. See plan item 13 for the arithmetic.
- **Item 30 / `TopBar.tsx:61-62`.** Reasoned from the anonymous frame alone, correctly at the time. The
  authed top-right group now has four frames of its own (A2), and they show `Fork` + theme + avatar with
  no `Download`.
- **The plan's "Remaining decisions" CRUD line.** Answered by A1.
- **Frame index rows for `65:24280` and `65:17596`** — *"not rendered — name-inferred"*. Both render
  fully. Read now, they **confirm** what T8 and T3 shipped rather than contradicting it: `65:24280` has
  `window-minimize`, Download + theme in the top right, and a full-width status bar; `65:17596` has the
  BOX INFO chevron with no pencil and the CRUD icons hidden, consistent with its Before Login placement.
  No functional gap — the index rows are simply stale.

---

# C. Cosmetic and documentation

- **Dialog card width.** Frames `114:24365` (270 tall) and `114:24747` (310 tall) are both **360px**
  wide, 24px padding, 312px content. `Dialog.tsx:38` defaults to **356**. 4px.
- **`65:23282`** missing from the frame index — the light-mode, sidebar-collapsed twin of `65:19433`.
  Nothing depends on it; it changes no decision.
- **Sticky `114:26732`** ("Ta strefa w przyszlosci moze sie rozrosnac o inne elementy, zarzadzanie
  userami, folderami etc.") sits beside My Demos' left nav. Forward-looking context, not a gap — it
  confirms the 320px rail is intended as a real nav rather than page furniture, which is how
  `MyDemos.tsx` builds it. Relevant when item 33 (Settings page) is scoped.
- **Design-side typos**, for the record: frame `114:23289` is named "Sahre links"; the DEPENDENCIES row
  reads `handsotable`. Joins `Optimilzation` / `Recipies` under logged item 21.

---

# D. Deferred-by-decision gaps, revisited

Multi-file tabs (now T12) was one of the plan's two explicit *Deliberate gaps*. Sweeping the rest of the
decision-shaped entries turned up one item that the frames **answer outright** and three that stand.

## D1. Item 27 is answered by the frames — keep both version readouts

Item 27 asks which of the two version readouts survives in `play`, on the stated grounds that
*"No frame shows the collision: `48:6560` is a saved demo, which has no version menu, and it is the only
frame that draws the bottom bar's right-hand group."*

That premise is a measurement error. **Five frames draw the version in both places at once** — the row-2
pill *and* the bottom status bar:

| Frame | Section |
|---|---|
| `72:15697` (Example, anonymous `play`) | Before Login |
| `72:17078` (Search) | Before Login |
| `114:21146`, `114:23289`, `114:24410` | After Login |

The first two predate the After Login section entirely, so this was answerable when item 27 was written.
**Resolution: keep both, the duplication is intended** — the pill is the control, the bar is the readout,
exactly as item 27 guessed the design "asks for each". No design call, no code. Close the item (→ T14).

## D2. The embed URL's `?theme=` parameter is inert

The plan's other *Deliberate gap* — "the app emits a preferred-theme hint; acting on it is not
DEV-2027". Both halves verified: `App.tsx:1117` builds every embed URL as
`${API_BASE}/embed/${linksId}?theme=${themeMode}`, and `workers/api/src/share.ts` — which serves
`/embed/:id` via `serveDemoAsset` — **never mentions `theme`**.

On whether the design asks for embed theming, the plan is probably right. `72:11913` and `72:13670` are
structurally identical (118 descendants each) and differ only in colour, so they read just as naturally
as *a light example and a dark example* — which is ADR-0022's position that the grid's theme comes from
the example's own `ht-theme-main.min.css` inside the iframe, the same argument that settles mixed frame
`65:21451`. Deferring the feature is defensible.

**The parameter is a separate problem, and it is a defect either way.** We hand users an embed URL
carrying a setting that provably does nothing. Recommend **dropping `?theme=` from the emitted URL**
unless embed theming is actually scheduled — a URL should not promise behaviour the server doesn't have.
One line (→ T13).

## D3. The Settings page stands as split out (item 33)

`114:26833` is fully specified — Name, Description, avatar Upload / Remove — and nothing behind it
exists: two tables (`demos`, `build_cache`), no `/api/me`, identity is a bare email in
`demos.created_by`. A profile table, a migration, profile `GET`/`PATCH` and avatar upload to R2 is a
feature, not design-system application. **Decision stands.**

Worth stating plainly, though: it is the only fully-drawn frame in the file with no implementation, and
it surfaces to users as a permanently disabled menu row. That is how `114:21480` draws it, so nothing is
wrong — but it is the branch's one visible "not built yet".

## D4. Owner name and avatar (item 37) — one cheap check could shrink D3

The design draws a photo avatar plus a display name ("Artur") in three places: My Demos card footers
(`114:26750`), the account trigger, and Settings. We ship a monogram from the email's first letter and
the local part.

The plan already names the unblocking step and it has not been done: **one live call to
`/broker/userinfo`**. The broker is Google-backed and plausibly returns `name` and `picture`; this repo
has never read or typed them, so it cannot be settled from a code read. If the payload carries them, D4
closes without a profile table and D3 gets materially smaller. Worth doing before D3 is scoped.

## Still open, no new evidence

Listed so the sweep is complete, not re-argued. All were logged with a rationale that still holds:

- **Colour reconciliation — items 1, 6, 23, 38.** Dark `textMuted`; the ramp's four steps against three
  painted surfaces; Figma `accent-color` `#4669f6` vs shipped `#1A42E8`; accent-on-dark under WCAG AA.
  Each item says a single design call fixes it — they should be **one conversation**, not four.
- **Item 14** (Tier-1 shows a `Live preview` placeholder where frames show a `/share/:id` URL),
  **item 15** (version warning clamped to one line, no designed home), **items 21/24** (cascader shape vs
  a 28-category manifest against the frame's 15), **item 8** (static `Spaces: 2` / `UTF-8` / `Layout`).
- **Item 9** (close ✕ decorative) — **closed by T12**, which makes it a real control.

---

# Subtask breakdown

Decisions taken on this audit (2026-08-03), grouped into five subtasks by topic. T11–T13 are mutually
independent and T14 trails all of them (see [Sequencing](#sequencing) — this originally said "T11–T14",
corrected in DEV-2171); T10 is the only one carrying an open design question, and only for one control.

## T10 — Authed action surfaces: retire the unframed bar

Findings A2, A3, A4, A5. The largest item and the one that realigns the branch with the design.

| Control | Today | After |
|---|---|---|
| `Fork` | action bar, primary button | **top bar** right group (`114:24402`) |
| `Share` | action bar, `edit` only | **preview bar** icon (`tabler-icon-share`) |
| custom version | action bar, 260px input | **version-pill pencil** (`114:24396`) |
| `Embed` | action bar, `play` only | folds into the Share icon — see below |
| `Save` | action bar, `edit` only | **no frame** — see below |

**`Embed` needs no new surface, and this is why no frame draws one.** `onEmbed` (`App.tsx:998`) and
`onFork` (`App.tsx:1030`) issue the *same* `POST /api/demos` with the same `filesRef.current`, differing
only in the title suffix and the aftermath: Embed calls `setLinksId(id); setShareLinksOpen(true)`, Fork
does `location.href = "/edit/" + id`. And the dialog Embed opens is the one whose third row is already
**"Docs embed URL (handsontable.com only)"** (`ShareLinks.tsx:58`, frame `114:24384`).

So the proposal is: **the preview-bar share icon is mode-aware.** In `edit` it opens the links for the
saved demo (today's Share). In `play` it mints the demo first and then opens the same dialog (today's
Embed). One designed affordance, one dialog, nothing deleted, and no navigation change — which matters,
because Embed deliberately keeps you on the playground while Fork navigates away. Collapsing Embed into
`Fork` instead *would* be a behaviour regression, so it is not proposed.

**`Save` is genuinely undesigned.** No frame in the file shows it — `114:21146` carries `Fork`, so it
depicts a demo that isn't yours, and `48:6560` (yours) shows `Download`. ADR-0023 rule 1 therefore
applies: keep it, restyle it, placement is dev judgment. Recommended: the same mode-keyed top-right slot,
which already holds `Fork` when the demo isn't yours and `Download` when it is, plus `Cmd/Ctrl+S`.
**This is the one item worth a line from design before the relayout starts.**

**In-flight states are the hidden cost.** The bar also carries `saving` / `sharing` / `embedding` /
`dirty` and their labels (`Saving…`, `Creating…`, `Preparing…`, `Save •`). A 36px icon button cannot show
"Creating…", so an icon-form pending treatment — in-place spinner, or disabled plus `title` — has to
exist *before* Fork and Share move. Do this first within the subtask.

Files: `TopBar.tsx`, `PreviewBar.tsx`, `AuthedActionBar.tsx` (delete), `MenuButton.tsx`, `styles.ts`,
`App.tsx`. Also removes the two stale comments (`AuthedActionBar.tsx:1-7`, `App.tsx:1253-1254`).
Size **M**.

## T11 — Sidebar file CRUD follows login, not mode

Finding A1. Decided: gate on `!!user && route.mode !== "share"`.

`App.tsx:1192-1194` — three handler props. Withholding them is also what flips the shell's `editable`
switch, so nothing else needs touching. Add e2e coverage for the newly-enabled case (signed in, `play`),
which no spec exercises today. `share` stays locked: the design never models ownership, so granting a
visitor CRUD on someone else's demo would be a behaviour change rather than a restyle. Size **S**.

## T12 — Editor tabs: multi-file tabs + unsaved-changes indicator

Finding A6 **plus multi-file tabs**, which the plan lists as its first *Deliberate gap* ("tab strip
ships styled, single active file") and which every workspace frame contradicts by drawing two tabs
(`index.ts`, `index.html`). Folded together deliberately: the close ✕ and the dirty dot are only
*meaningful* once more than one file can be open, so splitting them means rebuilding `EditorTabs` twice.

**The good news, established by reading the code rather than assumed: closing a tab cannot lose edits.**
File contents live in the app's `files` map (`onEdit(path, contents)` → `filesRef.current`,
`App.tsx:934`), and `EditorShell` holds only `active: string` — a view pointer. A tab is a *view*, not a
buffer. So the concern behind "closing a changed file must not discard those changes" is already
satisfied by the architecture: no confirmation dialog and no draft retention are needed. Verify it with a
test rather than a dialog.

### The one real data-model change

`dirty` is a **single workspace-level boolean** (`App.tsx:467`, set by every edit). Rendered per-tab as
is, editing one file would dot *every* open tab. A truthful per-tab indicator needs per-file dirty
tracking — a `Set<string>` of edited paths in `App`, added to by `onEdit`, cleared on save/mount, and
maintained by `addFile` / `renameFile` / `deleteFile`. The existing boolean stays for `Save •`.

### Scope

- `openPaths: string[]` + `active` in `EditorShell`, replacing the lone `active`. Tree selection opens or
  focuses; the ✕ closes and activates a neighbour.
- Dot at rest when that file is dirty, ✕ on hover — needs a rule in the app's global block, since
  `:hover` is unreachable from the package and an inline value on the same property would outrank it
  (open items 16/36).
- **Reconcile `openPaths` when the file set changes.** `EditorShell:128-133` already does this for
  `active`, because `props.files` is replaced wholesale on every example switch — the same trap T3 hit
  with directory expansion. Tabs pointing at files from the previous workspace must not survive.
- Roving `tabindex` across the strip; `role="tablist"` is already in place.

### Undesigned — needs a call inside the subtask

No frame covers any of these, so ADR-0023 rule 1 applies (dev judgment, recorded):

- **Tab overflow.** The frames show 2 tabs in a 625px strip. Eight open files in a sidebar-open editor
  will not fit — scroll the strip, or overflow menu?
- **Empty state** when the last tab is closed. No frame shows an editor with no file open.
- **Per-file undo history and scroll.** `CodeEditor` is keyed on `active` (`EditorShell:188`), so
  switching files remounts CodeMirror and drops undo history and scroll position. Tolerable when
  switching is a deliberate tree click; much more visible when tabs invite rapid switching. Fixing it
  means either keeping instances mounted or persisting `EditorState` per path — the main quality decision
  in this subtask.
- **Persistence** of the open set across reload, and keyboard shortcuts (`Cmd/Ctrl+W`, `Ctrl+Tab`).

Files: `EditorTabs.tsx`, `EditorShell.tsx`, `CodeEditor.tsx`, `App.tsx`, `apps/authoring/index.html`.
Size **M** (was S before multi-tab folded in).

## T13 — Small fixes

Three XS items with unambiguous evidence:

- **Example pill mark** (item 13). Wire `markUrl` into `examplePill` and delete the stale comment that
  justifies its absence by an asset gap T3 closed. **Done by T13** — for the 3 pill sites that name an
  example, *not* "both pill forms": `114:26625` ("My Demos") draws no mark, and it uses the same
  shrink-to-fit form as the demo title, so the mark does not follow the form. See plan item 13.
- **Dialog width** 356 → 360 (`Dialog.tsx:38`). **Done by T13.**
- **Drop the inert `?theme=`** from the emitted embed URL (D2) — or schedule embed
  theming. Not both left as-is. **Done by T13** — dropped.

Size **XS**.

## T14 — Documentation corrections

No code. Bring the plan in line with the file as it now stands:

- Frame index: add `114:21146`, `65:23282`, stickies `114:26599` and `114:26732`; drop the *"not
  rendered — name-inferred"* note from `65:24280` and `65:17596`.
- Append these findings as open items 40+, per the running-log convention.
- Record in ADR-0023 that the authed-action-bar premise expired when the After Login frames landed, so
  the ADR isn't read later as still-current justification.
- Close the plan's "Remaining decisions" CRUD line, answered by T11.
- **Close item 27** with D1's evidence: five frames draw both version readouts, two of them predating the
  After Login section, so the item's "no frame shows the collision" premise was a measurement error.
  Keep both.
- **Remove "Multi-file tabs" from the plan's *Deliberate gaps*** — T12 closes it. ADR-0023 and the T4
  section both state single-file-at-a-time as a shipping decision, and `EditorTabs.tsx:1-10` plus
  `EditorShell.tsx:177` carry comments asserting it; all four need correcting or they will read as
  current constraints.

Size **XS**.

## Sequencing

> **CORRECTED (DEV-2171).** This section originally read *"T11–T14 are independent and can land in any
> order."* That is wrong for **T14**, which is a trailing sweep: every claim it corrects is invalidated
> by one of T10–T13, so it cannot precede them. Correct reading: **T11–T13 are independent; T14
> trails all of them.** The rest of this section is now history — all five subtasks have landed.

T11–T13 are independent and can land in any order. T10 should follow T11, since both touch the same
region of `App.tsx`. Within T10, the icon-form pending state comes before the relocations. T14 runs
last, after every subtask whose comments it corrects.

T10 and T12 are the two substantial ones (**M** each) and are the natural parallel pair — T10 is chrome
around the panes, T12 is inside the editor pane. They overlap only on `dirty`: T10 deletes the component
that consumes it today, T12 splits it per file. Whichever lands second inherits that reconciliation, so
it is worth agreeing the shape of the per-file dirty set before either starts.

**Order actually taken:** T10 (`b336b96`, DEV-2167) → T11 (`25ee6ba`, DEV-2168) → T12 (`2169818`,
DEV-2169) → T13 (`59be18d`, DEV-2170) → T14 (DEV-2171). T10 landed before T11 rather than after; the
`dirty` reconciliation fell to T12, which split it per file over the component T10 had already deleted.

---

# Original triage table (superseded)

Kept for provenance. The two questions below were **answered** on 2026-08-03 — CRUD follows login
excluding `share`, and the authed action bar is retired — and the subtask breakdown above supersedes the
cost estimates here. A6's "low confidence / XS" line is the most out-of-date row: confirmed as a real
requirement and folded into T12 alongside multi-file tabs.

| # | Finding | Kind | Cost |
|---|---|---|---|
| A1 | CRUD gate: mode → auth | needs design confirmation, then small code change | S |
| A5 | Retire the authed action bar (needs A2+A3+A4) | structural realignment | M |
| A2 | `Fork` → top bar | relayout | S |
| A3 | `Share` → preview bar icon | relayout | S |
| B | Item 13 — wire `markUrl` into the example pill | one import | XS |
| A4 | custom version → version-pill pencil | relayout, medium confidence | S |
| A6 | tab dirty dot | small, low confidence — confirm with design | XS |
| C | dialog 356 → 360 | cosmetic | XS |

**Two questions for design, and they gate the rest:**

1. Does sidebar CRUD follow **login** (sticky `114:26599`) or **mode** (sticky `72:14532`, as read by
   T3)? If login: does it include `share`, where the visitor does not own the demo?
2. Are `Fork` / `Share` / the version pencil in the After Login frames the intended homes for those
   actions — i.e. should the unframed authed action bar go away?
