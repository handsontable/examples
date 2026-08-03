# ADR-0023: DEV-2027 redesign — scope rules, deferred gaps, and shipping

**Status:** Accepted — scope **rules** stand; three applied decisions superseded by
[ADR-0025](0025-redesign-scope-corrections-after-login-frames.md) after the Figma **After Login**
section (`114:*`) was added: the authed action bar (retired), the file-CRUD gate (now signed-in,
not `edit` mode), and the multi-file-tab deferral (now in scope). The unresolved caveat at the foot
of this record is answered there.

## Context
The DEV-2027 design (Figma `KCl2Csh9WUSwCrddffnYuD`, section `18.1`) covers the authoring
shell, the preview, and the embed. It does not cover everything the runner does today, and it
introduces elements the runner does not have. Without a stated rule, each subtask would decide
independently whether an omission means "delete" or "not drawn".

Deploy is manual (no CI), so how the work is branched determines how many production deploys
users see mid-redesign.

## Decision

**Scope rules.**
1. A feature that exists but is absent from the design is **kept and restyled** to the design
   system. Omission is not removal.
2. A design element that is new is decided per item: build now, or split into its own feature
   task and recorded as a gap.

**Applying those rules:**
- **Authed actions get their own bar** in the right panel, above the preview, rendered only
  when signed in: `Save`, `Share`, `Embed`, `Fork this demo`, the custom-version input, and
  `My demos` (`Toolbar.tsx:73-132`, `App.tsx:924`). No frame shows them, and the designed two
  rows have no space budgeted. Anonymous visitors therefore see exactly the designed chrome.
  <!-- Superseded by ADR-0025 §1: the bar is RETIRED. Its premise — "no frame shows them" — expired
       when the Figma After Login section (`114:*`) landed: `114:21146` draws `Fork` in the top bar,
       `share` in the preview bar and a pencil on the version pill. Every action moved to a designed
       home; `AuthedActionBar.tsx` was deleted in T10 (DEV-2167). See plan open item 40. -->
- **`/d/:id` and `/embed/:id` are out of scope.** They are prebuilt static R2 artifacts served
  by `serveDemoAsset` (`workers/api/src/share.ts:353`) and contain no shell code — the embed
  shows the preview and nothing else (see ADR-0006, ADR-0009). Frames `72:11913` / `72:13670`
  need no work.
- **The Tier-2 boot log stays.** The design shows only a spinner; the live install/dev-server
  log is the main signal when a container is slow or stuck. Treated as a gap in the design,
  restyled rather than dropped.
- **File add / rename / delete gate to `edit` mode.** These are implemented
  (`App.tsx:665-698`) and currently passed unconditionally (`App.tsx:967-969`), so they appear
  in every mode. Per Figma sticky `72:14532` they are hidden in `play` and `share`; `edit`
  (your own saved demo) keeps them. Editing file *contents* is unchanged in all three modes.
  <!-- Superseded by ADR-0025 §2: the gate is BEING SIGNED IN, not `edit` mode — `!!user && !isShare`.
       Sticky `114:26599` states it outright ("CRUD w sidebar po zalogowaniu"), and the `hidden` flag
       is bimodal across the file: hidden in all 7 Before Login frames, visible in all 4 After Login
       ones. So `72:14532`'s "fork/view mode" means *not signed in*, which is the reading this bullet
       got wrong. Shipped in T11 (DEV-2168); see plan open item 41. -->
- **Framework selection is a restyle, not a feature.** The button group already exists
  (`App.tsx:881-899`) and already renders only for examples with framework variants — i.e.
  docs examples. Starter templates have no variants and are chosen through the example
  cascader. The redesign changes its form, not its behaviour.
- **Undesigned surfaces are rebuilt to the token set, not cut**: My demos, the Share/Edit
  dialogs, error states, favicon/titles/meta, and responsive behaviour. No frames exist for
  any of them — the two "Resize" frames show the splitter drag, not a breakpoint study.

**Deferred gaps** (designed, deliberately not built now):
- **Multi-file tabs.** The tab strip ships styled, with one open file at a time; the shell
  keeps its single `active` string. The design shows two tabs; adding real multi-tab state
  later needs no further design work.
  <!-- Superseded by ADR-0025 §3: multi-file tabs are IN SCOPE and shipped in T12 (DEV-2169). The ✕
       and the unsaved indicator are only meaningful with more than one open file, so deferring them
       meant building `EditorTabs` twice. T4's bet held — both tab states were already styled, and the
       change was state (`openPaths` + per-file dirty), not a restyle. This leaves *embed theme
       handling* as the only deferred gap. See plan open items 42 / 43. -->
- **Embed theme handling** — see ADR-0022.

**Shipping.** One integration branch `feat/DEV-2027-redesign` off `master`. Every subtask is
its own branch, PR'd into it. The redesign reaches production in a single deploy from the
integration branch.

## Consequences
- Subtask PRs stay small and reviewable while users never see a half-redesigned app.
- The integration branch is long-lived and will need rebasing against `master`.
- Theming (ADR-0022) must land first and alone; every other subtask rebases on it.
- The authed action bar is an intentional departure from the frames, and needs design sign-off
  at review.
  <!-- Moot per ADR-0025 §1: there is no departure left to sign off — the bar is deleted (T10,
       DEV-2167) and every action it held now sits in a frame. What *does* still want sign-off is
       `Save`'s placement, the one authed action no frame draws; see plan "Remaining decisions" 1. -->
- One item to confirm with design: no frame anywhere in `18.1` shows a file `+` control, so
  "`edit` keeps CRUD" is read from sticky `72:14532`'s wording rather than demonstrated. If
  design intends CRUD to disappear everywhere, only the `edit` row above changes.
  <!-- Answered by ADR-0025 §2 — this is the caveat the Status line refers to. `114:21146` and its
       three After Login siblings *do* draw `+` and `folder-plus`, unhidden, so the premise ("no frame
       anywhere") was false once the `114:*` section landed. CRUD does not disappear; it follows
       sign-in. See plan open item 41. -->
