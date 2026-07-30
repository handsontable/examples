# ADR-0022: Shell theming via CSS custom properties; the example owns its own theme

**Status:** Accepted

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
  (`apps/authoring/src/App.tsx:811`, surfaced via `ShareDialog.tsx`). Whether and how the
  embed acts on that hint is out of scope here.

## Consequences
- Every visual subtask in the redesign depends on this landing first; it is a refactor with a
  wide blast radius and no user-visible payload of its own.
- No hard-coded colour may remain outside `theme.ts`, save the SVG logo assets, the pre-paint
  background in `apps/authoring/index.html`, and the generated seti-ui file-icon palette
  (ADR-0024) — upstream brand colours, identical in both modes.
- A demo whose source declares a light theme renders light inside a dark shell. That is
  intended, and matches the design.
- Re-theming the example on demand stays possible later, but it is runtime/iframe plumbing —
  a separate decision, not an extension of this one.
