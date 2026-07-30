# ADR-0023: DEV-2027 redesign — scope rules, deferred gaps, and shipping

**Status:** Accepted

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
- One item to confirm with design: no frame anywhere in `18.1` shows a file `+` control, so
  "`edit` keeps CRUD" is read from sticky `72:14532`'s wording rather than demonstrated. If
  design intends CRUD to disappear everywhere, only the `edit` row above changes.
