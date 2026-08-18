# ADR-0035: The shell drives the preview's colour scheme, unless the demo declares one

**Status:** Accepted (DEV-2561; supersedes
[ADR-0028](0028-shell-theming-via-css-custom-properties.md)'s "the example's theme stays the
example's own" decision, and builds the plumbing that ADR deferred)

## Context
ADR-0028 decided that the shell does not re-theme the running preview, and argued it from one
fact:

> the running example imports its own stylesheet (`handsontable/styles/ht-theme-main.min.css`)
> inside the preview iframe — the shell cannot restyle it with CSS, and doing so would mean
> mutating example source or injecting into the iframe document.

Its consequence followed from the same fact:

> A demo whose source declares a light theme renders light inside a dark shell. That is
> intended, and matches the design.

DEV-2200 (`6fd1cafd`) deleted that import. Starters moved to the JS theme object, `theme:
mainTheme`, and `mainTheme` declares no `colorScheme` — so `ThemeBuilder` falls to its default
`'auto'` and `ThemeManager` emits `color-scheme: light dark`. **No stock demo declares a scheme
any more.** ADR-0028's consequence describes a state that no longer exists: rather than
rendering the theme its source names, a demo renders whatever the *visitor's operating system*
prefers, which the shell has no part in and the author never chose.

Measured on production before this change, React starter, browser emulating a dark OS: buckets
15 and 16 (still on `themeName` + the CSS import) render light; buckets 17, 18 and `next` render
dark, on both tiers. The mismatch is visible as light chrome around a dark grid, or the reverse,
with no control that reconciles them.

Two further things changed since ADR-0028 was written. DEV-2496 built a `postMessage` bridge
into the preview for the Style panel's live theme patch, so "injecting into the iframe document"
is no longer hypothetical — it is a shipped, tested mechanism. And DEV-2527's monitor
established an injection seam on each tier that reaches the running document without touching
the authored file map.

## Decision
- **A demo that declares a colour scheme owns it.** The shell never overrides one.
- **A demo that declares none follows the shell.** That is now the only case where the shell
  decides, and it exists because the alternative is not "the author's choice" but "the reader's
  operating system".
- **Starters declare `colorScheme: 'light'`.** A demo copied out of the playground renders the
  same for every reader. This restores, in the source, the property ADR-0028 assumed the
  stylesheet was providing.
- **The lever is `color-scheme`, re-declared over the demo's own.** Every Handsontable token
  that differs between light and dark is a `light-dark()` pair, so one declaration flips all of
  them. `packages/runtime/src/scheme.ts` injects a receiver that maintains a single
  `[class*="ht-theme-"] { color-scheme: … !important }` rule. The `!important` is load-bearing:
  `ThemeManager` prepends its own `<style>` *inside* the theme wrapper, so an equal-specificity
  rule of ours loses on document order and changes nothing at all — measured, not assumed.
- **Which demos the shell may decide for is settled in the shell, not in the receiver.** From
  inside the frame, "the runner pinned this starter to light" and "this demo deliberately
  declares light" are indistinguishable. `App.tsx` knows both, and sends `auto` — stand down —
  for a docs example or once the Style panel has written a theme module.
- **The Style panel gains `auto`.** `COLOR_SCHEMES` was `["light", "dark"]`, so the panel could
  not express "follow the visitor" at all and applying it always pinned the grid.
- **The receiver is a constant, never a value.** It learns the mode over `postMessage`.
  Injecting the current scheme would change the sandbox bytes on every toggle, and
  `SandpackRuntime.sameFiles` would turn each one into a full rebuild — the cost DEV-2496's
  bridge exists to avoid.

## Consequences
- Light chrome with a dark grid is no longer a state the product can reach by accident. It
  remains reachable deliberately, through the Style panel, and that is the point of the
  precedence rule.
- The receiver ships in the *derived* file map only. Download-zip, fork and the
  StackBlitz/CodeSandbox exports read the authored map and never see it —
  `pipeline/scheme-bridge.test.mjs` pins that, as it does for the monitor.
- Unlike the monitor, the receiver is ungated: it is a shipped feature, not diagnostics, so
  gating it on `MONITOR_DEMOS` would tie the product to a debugging flag and leave `wrangler
  dev` unable to exercise it.
- The eight theming-guide docs examples that ship their own `ht-theme-*-dark` class keep it.
  They exist to demonstrate theme switching, and one of them has its own in-preview scheme
  dropdown.
- `/embed/:id` carries the receiver too, and it is inert there: the documentation page that
  frames it never sends the message. Embed *theming* stays deferred, as ADR-0028 and ADR-0025
  left it.
- Buckets 15 and 16 are unaffected and need no change — they still use `themeName` plus the CSS
  import, whose `.ht-theme-main { color-scheme: light }` already pins them.
- `examples/` on master feeds only the `next` bucket. Buckets 17 and 18 source from the frozen
  `prod-examples/17` and `/18` branches, so the starter half of this decision does not reach
  production until it is backported there (ADR-0029). The runner half — the bridge — ships from
  master to every bucket at once.
