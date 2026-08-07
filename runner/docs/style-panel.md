# Style this demo

The **Style** panel restyles the example you have open with the same controls as
[Theme Builder](https://theme-builder.handsontable.com/) (DEV-2047).

## What it covers

| | |
|---|---|
| Preset stack | tokens (main/horizon/classic), colors (main/horizon/classic/ant/shadcn/material), icons, colour scheme, density |
| Palette | brand ramp `primary.100–600`, neutral `palette.50–950`, white/black, with a brand picker that generates all six primary steps |
| Tokens | the full catalogue — 272 tokens across 5 common sections and 18 components |
| Density sizes | per-measurement overrides on top of the preset |
| Fonts | a bare family name is fetched from Google Fonts by the generated module |
| Describe a style | natural language → theme, the Theme Builder feature |
| Copy for my app | the same module source, to paste into a real project |
| Reset | removes the module and the wiring |

The theme survives a reload (`localStorage`), and **Reset** clears it.

## The token catalogue

`apps/authoring/src/theme/tokens.ts` is Theme Builder's `src/utils/tokens.ts`
**vendored verbatim** (DEV-2199) — 272 tokens with the label, description,
`type`, select `options`, numeric `params` and `linkedTokens` each one carries.
Don't hand-edit it; re-copy it and update the blob SHA in its header.

Everything else derives from it:

| | |
|---|---|
| `theme/vocabulary.ts` | normalises it into `COMMON_SECTIONS` / `COMPONENT_SECTIONS`, plus `ALL_TOKENS`, `TOKENS_BY_KEY` and `TOKEN_KEYS` |
| `workers/api/src/theme-tokens.generated.ts` | the whitelist `/api/theme` filters the model's answer through — regenerate with `node --experimental-strip-types scripts/gen-theme-tokens.mjs` |

`pipeline/theme-tokens.test.mjs` fails if the two drift.

It replaced a hand-written list of ~40 tokens with an invented three-way kind.
That list had drifted: `wrapperBorderRadius` and `wrapperBorderColor` are not
Handsontable tokens (the real names are `borderRadius` and `borderColor`), so
those two controls silently did nothing.

The panel still renders every token as a text box with a swatch for colours —
the typed controls (`select` → dropdown, `size` → density-aware, `numeric` →
unit input) and the Foundation/Common/Component tabs are the next step of
DEV-2199, and this port is what unblocks them.

## Generated source is a script-injection surface

The theme module is written into the demo and evaluated there, so **every**
interpolated key and value goes through `lit()` (`JSON.stringify`) — keys
included. Keys look trustworthy because they come from the catalogue, but a
theme restored from `localStorage` or arriving in a shared link carries whatever
keys it likes, and an unquoted one closes the object literal just as effectively
as an unquoted value. `pipeline/theme-codegen.test.mjs` enforces it.

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
