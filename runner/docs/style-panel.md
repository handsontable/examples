# Style this demo

The **Style** panel restyles the example you have open with the same controls as
[Theme Builder](https://theme-builder.handsontable.com/) (DEV-2047).

## What it covers

| | |
|---|---|
| Preset stack | tokens (main/horizon/classic), colors (main/horizon/classic/ant/shadcn/material), icons, colour scheme, density |
| Palette | brand ramp `primary.100–600`, neutral `palette.50–950`, white/black, with a brand picker that generates all six primary steps |
| Tokens | typography, colours, header, cells, frame, shadow |
| Density sizes | per-measurement overrides on top of the preset |
| Fonts | a bare family name is fetched from Google Fonts by the generated module |
| Describe a style | natural language → theme, the Theme Builder feature |
| Copy for my app | the same module source, to paste into a real project |
| Reset | removes the module and the wiring |

The theme survives a reload (`localStorage`), and **Reset** clears it.

## How a theme reaches the grid

Through Handsontable's **JavaScript theme API**, the same one Theme Builder
uses and the one the [Theme customization](https://handsontable.com/docs/javascript-data-grid/theme-customization/)
docs document:

```js
import { mainTheme, registerTheme } from 'handsontable/themes';

export const customTheme = registerTheme(mainTheme);
customTheme.params({ colors: { primary: { 500: '#7e22ce' } }, tokens: { fontSize: '13px' } });
customTheme.setColorScheme('dark');
customTheme.setDensityType('compact');
```

That module is written into the example as `/handsontable-theme.(ts|js)` through
the same file-write path the editor and the AI assistant use — so it appears in
the file tree, hot-reloads into the preview, and travels with a **Download** or
a **Share**. Styling a demo is editing the demo.

### Wiring

The module has to be handed to the grid, and every framework constructs one
differently. Three shapes cover the whole catalog:

| Shape | Seen in | Edit |
|---|---|---|
| `<HotTable …>` / `<hot-table …>` | React, Vue wrappers | add or replace `theme={customTheme}` |
| `new Handsontable(el, { … })` | JavaScript, TypeScript, Astro | add `theme: customTheme` |
| `gridSettings = { … }` | Angular | add `theme: customTheme` |

Several starters already set a theme by hand (`theme={antTableTheme}`), and
those are replaced rather than duplicated. Anything unrecognised is **left
alone**: the panel writes the module and shows the one line to add. A theme
that fails to apply is a puzzle; a component file mangled by an over-eager
regex is a lost afternoon.

Applying repeatedly is idempotent — one import, one theme reference — and
Reset removes both.

## Describe a style

`POST /api/theme` is a port of Theme Builder's own chat edge function: a forced
tool call so the model can only answer in theme values, and a strict whitelist
on the way out. Token names must be in the panel's vetted set, palette keys
must be real ramp steps, presets must be real presets, and every value must
match a conservative CSS-value pattern — anything else is dropped rather than
written into someone's example.

It is a separate endpoint from `/api/chat` on purpose: the answer is structured
theme state rather than prose and file edits, so a styling request cannot
rewrite code. It shares the rate limits, the budget tiers and the `llm` cost
metering (see [cost-guardrails.md](cost-guardrails.md)).

Requests are asked to set **all six** primary steps for a recolour — one step
against five stale ones reads as a bug rather than a new brand colour.

## Configuration

None of its own: it uses the same `LITELLM_API_KEY` as the assistant. Without
it the panel works fully and only "Describe a style" reports being
unconfigured.
