# ADR-0025: DEV-2027 redesign — scope corrections after the After Login frames

**Status:** Accepted (supersedes parts of ADR-0023; narrows one bullet of ADR-0022)

## Context

ADR-0023 set the redesign's scope rules against Figma section `18.1` as it stood when the
subtasks were written. An **After Login** section (`114:*`) was added to the file later. T9
(DEV-2163) re-derived its own scope against it, but **T2–T8 were never re-audited**, so three of
ADR-0023's applied decisions rest on premises the new frames falsify.

The frames concerned are `114:21146` (a complete signed-in workspace, absent from the redesign's
frame index entirely), plus `114:21480`, `114:23289` and `114:24410`, which repeat its chrome. Each
finding below was checked across all four rather than read off one frame. What every node id shows
is tabulated in [ADR-0027's appendix](0027-dev-2027-shipped-deviations.md#appendix--figma-frame-index).

The node-level evidence originally lived in `dev-2027-figma-gap-audit.md`, a working document
retired with the redesign (DEV-2172). Its durable half is ADR-0027; the rest was history, or
questions that became their own tasks.

ADR-0023's scope **rules** are unaffected and still govern. What changes is how three of them apply.

## Decision

**1. The authed action bar is retired.** ADR-0023 gave `Save` / `Share` / `Embed` / `Fork` / the
custom-version input their own unframed bar above the preview, explicitly because "no frame shows
them". Three now have designed homes:

| Control | Designed home | Evidence |
|---|---|---|
| `Fork` | top bar, left of the theme toggle | 4 of 4 After Login workspace frames |
| `Share` | preview bar, head of the right icon group | 3 of 4 (`tabler-icon-share`) |
| custom version | pencil adjoining the version pill | `114:24396`; pill frame widened 161→181 to fit |

`Embed` needs no surface of its own. `onEmbed` and `onFork` issue the *same*
`POST /api/demos` over the same files, differing only in a title suffix and the aftermath — Embed
opens the ShareLinks dialog, Fork navigates to `/edit/:id` — and that dialog's third row already is
the docs embed URL. So the **preview-bar share icon is mode-aware**: in `edit` it shows the saved
demo's links; in `play` it mints the demo first, then shows the same dialog. Collapsing `Embed`
into `Fork` instead is rejected: Embed deliberately keeps you on the playground while Fork
navigates away, so that would be a behaviour regression.

`Save` remains genuinely undesigned — no frame shows it — so ADR-0023 rule 1 applies and placement
is dev judgment: the same mode-keyed top-right slot that holds `Fork` when the demo is not yours
and `Download` when it is, plus `Cmd/Ctrl+S`.

**2. File add / rename / delete gate on being signed in, not on `edit` mode.** ADR-0023 read Figma
sticky `72:14532` ("no rename / delete / add … in fork/view mode") as the shell's `play` + `share`
modes. Sticky `114:26599` states the rule directly — **"CRUD w sidebar po zalogowaniu"**, *CRUD in
the sidebar after logging in* — and the `hidden` flag on `tabler-icon-folder-plus` /
`tabler-icon-plus` is bimodal across the whole file: hidden in all 7 Before Login / Fork preview
frames, visible in all 4 After Login frames. "Fork/view" therefore means *not signed in*, which is
how the two sticky notes reconcile.

The gate becomes `!!user && mode !== "share"`. **`share` stays excluded**: the design's only axis is
Before / After Login and it never models ownership, so no frame depicts a signed-in visitor on
someone else's demo. Letting one mutate that file set would be a behaviour change, not a restyle.

**3. Multi-file tabs are in scope.** ADR-0023 deferred them, shipping the strip styled with one
open file. Every workspace frame draws two tabs, and the close ✕ and the unsaved-changes indicator
are only meaningful once more than one file can be open — so deferring them means rebuilding
`EditorTabs` twice. The tab glyph is a **dirty dot at rest, becoming the ✕ on hover**.

Closing a tab cannot lose edits, and this is a property of the existing architecture rather than
something to build: file contents live in the app's `files` map (`onEdit(path, contents)` →
`filesRef.current`), and `EditorShell` holds only `active: string`. A tab is a view, not a buffer.
No confirmation dialog is needed; the guarantee wants a test.

The real cost is that `dirty` is a single workspace-level boolean, so a truthful per-tab dot needs
per-file dirty tracking. Tab overflow, the last-tab-closed empty state, per-file undo history
(`CodeEditor` is keyed on `active`, so switching remounts CodeMirror) and open-set persistence are
all undesigned; rule 1 applies to each.

**4. The embed URL stops carrying an inert `?theme=`.** This narrows ADR-0022's last decision
bullet, which had the app append a *preferred* theme to the embed URL while leaving the embed's
response out of scope. The app does emit it (`App.tsx`), and `workers/api/src/share.ts` — which
serves `/embed/:id` — never reads `theme`. Handing users a URL carrying a setting that provably has
no effect is worse than not offering one, so **the parameter is dropped**.

Embed *theming* stays deferred, and ADR-0023's "frames `72:11913` / `72:13670` need no work" stands:
the two frames are structurally identical (118 descendants each) and differ only in colour, so they
read as a light example and a dark example — which is ADR-0022's position that the example owns its
own theme, the same argument that settles mixed frame `65:21451`. Re-theming an embed on demand
remains a separate decision, as ADR-0022 already says.

## Consequences

- The **signed-in** view now matches the frames, which is what ADR-0023 wanted and could not reach
  without authed frames to build to. The anonymous view was already correct and does not change.
- Retiring the bar has a prerequisite that is easy to discover too late: it carries the in-flight
  states `saving` / `sharing` / `embedding` / `dirty` and their labels (`Saving…`, `Creating…`,
  `Preparing…`). A 36px icon button cannot render "Creating…", so an icon-form pending treatment
  must exist **before** `Fork` and `Share` move.
- `Save`'s placement is the one item still wanting design sign-off. ADR-0023's own sign-off caveat
  on the authed bar is discharged — the bar is gone.
- ADR-0023's closing caveat ("no frame anywhere in `18.1` shows a file `+` control") is answered:
  `114:21146` and its three siblings show `+` and `folder-plus` unhidden.
- Multi-tab leaves the plan's *Deliberate gaps* list, which then holds embed theme handling alone.
- Per-file dirty state is a shared dependency of the CRUD gate work and the tab work; both touch
  the same region of `App.tsx`, so the CRUD gate should land first.
