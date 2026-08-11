# ADR-0028: Shell theming via CSS custom properties; the example owns its own theme

**Status:** Accepted (embed theme *hint* dropped by
[ADR-0025](0025-redesign-scope-corrections-after-login-frames.md); everything else stands)

## Context
The DEV-2027 redesign (Figma `KCl2Csh9WUSwCrddffnYuD`, section `18.1`) specifies a light and a
dark chrome, with a toggle in the top bar.

`packages/editor-shell/src/theme.ts` holds a single light palette, and `styles.ts` exports a
module-level `const s = {...}` computed from it at import time. A frozen object cannot respond
to a runtime theme change, so dark mode is a refactor of the styling layer rather than an
addition to the palette.

Several frames also pair a light chrome with a dark grid (`65:21451`) or the reverse
(`65:17596`), which reads as two independent theme axes. But the running example imports its
own stylesheet (`handsontable/styles/ht-theme-main.min.css`) inside the preview iframe — the
shell cannot restyle it with CSS, and doing so would mean mutating example source or injecting
into the iframe document.

## Decision
- Rewrite `theme.ts` as a two-mode token set emitted as **CSS custom properties** on a root
  element; convert `styles.ts` from a frozen object to variable-driven styles.
- One toggle, driving the **whole authoring app**. Persisted to `localStorage`, defaulting to
  `prefers-color-scheme`.
- CodeMirror uses GitHub Dark/Light, matching the documentation site (Figma sticky `11:2535`).
- **The example's theme stays the example's own.** The shell does not re-theme the running
  preview. Mixed light-chrome/dark-grid frames are that, not a second control.
- For `/embed/:id`, the app appends a *preferred* theme to the embed URL it hands out
  (`apps/authoring/src/App.tsx`, surfaced via `ShareLinks.tsx`). Whether and how the
  embed acts on that hint is out of scope here.
  <!-- Corrected in T9 (DEV-2163): this originally cited `ShareDialog.tsx`, which was dead
       code — nothing ever imported it. The live surface has always been `ShareLinks.tsx`.
       `ShareDialog.tsx` was deleted in T9; see plan open item 2. -->
  <!-- Superseded by ADR-0025: the hint is DROPPED. `share.ts`, which serves `/embed/:id`, never
       read `theme`, so the parameter had no effect — a URL promising behaviour the server does
       not have. Embed *theming* stays deferred and the rest of this bullet's reasoning (the
       example owns its own theme) is unchanged. See plan open item 44. -->


## Addendum (DEV-2209): the app's own drawers were outside the sweep

The two DEV-2047 panels — **Ask AI** and **Style** — predate the redesign and were never brought
onto this token set. Three findings worth keeping, because each is a rule this ADR states that a
surface outside `editor-shell` still managed to miss:

1. **A colour literal survived in `apps/authoring/src/theme/controls.tsx`.** Six of them: `#fff` on
   the token control, its trigger, the segmented control and the colour input, `#fbfbfd` on the
   inline popover, `#eef2ff` on a selected scale entry. Measured on the shipped dark shell, the
   trigger painted `#ffffff` behind `#d1d1d4` text — about 1.4:1, on the one control all 272 tokens
   are edited through. The "no hard-coded colour outside `theme.ts`" consequence above is not
   scoped to the shell package; it holds for every surface the app paints.
2. **Correct tokens are not sufficient — `border` on a `surfaceRaised` surface is invisible in
   dark**, because dark `border` *is* `surfaceRaised` (#222222). Both drawers are raised, so every
   control outline inside them disappeared. The rule, already used by `TopBar` and now applied
   here: a **control outline** that has to read takes `controlBorder`; a **divider** between two
   same-tone regions keeps `border`, which is why the drawer's header, footer and row rules were
   left alone.
3. **The drawer chrome is now one component**, `packages/editor-shell/src/Drawer.tsx` — the
   non-modal counterpart of `Dialog`, sharing its title treatment and close button but with no
   scrim, no focus trap, and its Escape handler on the **bubble** phase so a `Dialog` opened above
   a drawer still consumes the key alone.

Also from the same pass: the `✨`/`🎨` glyphs on the two triggers became `IconSparkles` /
`IconPalette` (ADR-0024's documented-exception list). An emoji renders in the OS's own colour and
weight — no token can reach it, which made them the only marks on the top bar that stayed light
when the bar went dark.

## Consequences
- Every visual subtask in the redesign depends on this landing first; it is a refactor with a
  wide blast radius and no user-visible payload of its own.
- No hard-coded colour may remain outside `theme.ts`, save the SVG logo assets, the pre-paint
  background in `apps/authoring/index.html`, the generated seti-ui file-icon palette
  (ADR-0024) — upstream brand colours, identical in both modes — and
  `workers/api/src/error-page.ts` (T9). The worker is a separate bundle that cannot import the
  shell, so its branded 404/410 pages restate a handful of the tokens as literals, in the same
  spirit as the pre-paint script. Keep them in sync with `theme.ts`.
- A demo whose source declares a light theme renders light inside a dark shell. That is
  intended, and matches the design.
- Re-theming the example on demand stays possible later, but it is runtime/iframe plumbing —
  a separate decision, not an extension of this one.
