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

## Tabs and typed controls

The panel splits the way Theme Builder's does — **Foundation** (preset stack,
palette ramps, density sizes), **Common** (the five shared sections),
**Component** (18 components, each drilling into its own sub-panel), **AI ✨**.

Foundation picks the **token mapping** and **icon set** as image tiles rather
than dropdowns — the presets differ in how the grid *looks*, which a thumbnail
conveys and the word "horizon" does not. The five PNGs are vendored from
theme-builder's `public/` into `apps/authoring/public/theme-tiles/`; their blob
SHAs are in the commit that added them.

Each token renders the control its `type` asks for (`theme/controls.tsx`, ported
from `panel/tabs/components/TokenItem.tsx`):

| `type` | Control |
|---|---|
| `select` | dropdown from `token.options` |
| `size` | pick from the sizing scale, follow a density slot, or type a value — trigger shows the resolved size |
| `color` | common colours, base/primary/palette swatches, or a raw colour |
| `numeric` | stepper carrying the token's own `unit`/`step`/`min`/`max` |
| *(other)* | text |

Every row carries its label and description, and a **Reset that appears only
once the token is overridden**.

Two behaviours worth knowing:

* **Values resolve.** `borderRadius` is `"sizing.size_1"`, which is `4px`;
  `cellHorizontalPadding` is `"density.cellHorizontal"` → `"sizing.size_2"` →
  `8px`. `theme/resolve.ts` follows those chains so a control shows the value
  rather than the reference. It resolves against the Handsontable version *this
  app* is built with, not the one in the version dropdown.
* **Colours are `[light, dark]` pairs.** Picking a raw colour writes only the
  half matching the scheme you're looking at, so styling in light mode doesn't
  silently rewrite dark mode. Picking a *common* colour (`tokens.accentColor`)
  writes a reference instead, which brings both variants along.
* **Linked tokens move together.** The catalogue pairs each column-header token
  with its row-header counterpart (`headerForegroundColor` →
  `headerRowForegroundColor`, plus the highlighted and active variants). Setting
  *or resetting* one writes all of them — a grid with a restyled column header
  and a stock row header just looks broken.

## Density sizes are per variant

`density.sizes` is keyed by density variant, and all three are editable —
`{ comfortable: { cellVertical: "sizing.size_5" } }` — so a theme still behaves
when the grid is switched between compact, default and comfortable. The editor
has its own variant switcher, independent of the variant the grid is on, and
says so when the two differ.

All fifteen `DensitySizeKey`s are exposed, grouped as theme-builder's density
modal groups them. `cellVertical` and `cellHorizontal` — cell padding, the ones
people actually reach for — were missing entirely before DEV-2199.

A theme saved under the old flat shape is migrated on load
(`migrateThemeState`): a flat object is read as belonging to the variant the
theme was saved with, which is the only reading that can be right.

## Reset returns the demo to how it arrived

Wiring takes over a demo's existing `themeName` — `theme` and `themeName` are
aliases and Handsontable warns and ignores one when both are set. The displaced
value rides along in the marker comment on the generated import, so **Reset puts
it back**, in place. Before DEV-2199 it was simply dropped and a reset demo came
back *unthemed* instead of on `ht-theme-main`.

Wiring also swaps in place rather than deleting the line it found. The earlier
version removed the whole *line* containing `themeName`, which erased
single-line elements outright — `<HotTable data={data} themeName="…" />` lost
its grid.

`pipeline/theme-wiring.test.mjs` runs the real codegen over every wiring shape
(plus single-line variants, SFCs and Astro) and asserts apply-then-reset is
byte-identical.

## What only a browser can tell you

`e2e/style-apply.spec.ts` (opt-in, `E2E_LIVE=1`) is the one test that **executes**
a generated theme module: it drives the panel, then reads the theme class
Handsontable put on the root wrapper and the rendered row height, one case per
wiring shape.

It exists because everything else here reads generated *text*, and text was green
throughout the whole time Vue was being handed JSX and five starters were
discarding the theme over a CSS class. Two rules it encodes:

* **Colour is not a theme signal.** Several starters stripe their own rows, and a
  starter stylesheet outranks the theme's `:where()`-wrapped tokens — so what a
  cell reads is the starter's arithmetic, not the theme's. Those rules used to
  pin `background: #fafbff`, which made a themed grid and an unthemed one read
  the same; they now mix the tint out of `--ht-foreground-color` and
  `--ht-background-color` so it follows the theme (DEV-2197), but they still
  decide the pixel. Assert on the `ht-theme-*` class and on row height instead.
  `e2e/row-striping.spec.ts` is the one place colour *is* read, and only as a
  relationship between two rows — never as a value.
* **Density is settled by row height.** A wrongly-keyed `density.sizes` is
  ignored in silence, so the generated source cannot distinguish the two
  readings and the rendered cell can.

`?example=angular` is `test.fixme`: its wiring is correct, but **no** edit
reaches the Angular preview — a bare `<p>` typed into its template was still
absent after 90 seconds, while the same probe on `react-js` and `astro` (also
Tier 2) appears in about ten. That blocks the editor and the AI assistant there
too, so it is a container defect rather than a theming one — DEV-2216.

Run it with **`--workers=1`** whenever `astro` or `angular` is selected. Those
are the Tier-2 cases; the pool holds five container slots and sessions are not
torn down between tests, so a parallel run leaves the second preview stuck on
`booting` — a failure that looks like the product and is not.

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
import { getTheme, hasTheme, registerTheme, reinitTheme } from 'handsontable/themes';
import tokensPreset from 'handsontable/themes/static/variables/tokens/main';

const THEME_NAME = 'custom-theme';
const config = { tokens: tokensPreset, colors: { … }, icons: { … }, density: 'compact', colorScheme: 'dark' };

// Re-initialise rather than register twice: the module is re-evaluated on every hot reload.
if (hasTheme(THEME_NAME)) reinitTheme(THEME_NAME, config);
else registerTheme(THEME_NAME, config);

export const customTheme = getTheme(THEME_NAME).params({ tokens: { fontSize: '13px' } });
```

The colour scheme and the density variant live **in the config**, not behind
`setColorScheme`/`setDensityType` calls: presets, `icons` and the density
`sizes` are only accepted there.

That module is written into the example as `/handsontable-theme.(ts|js)` through
the same file-write path the editor and the AI assistant use — so it appears in
the file tree, hot-reloads into the preview, and travels with a **Download** or
a **Share**. Styling a demo is editing the demo.

### Wiring

The module has to be handed to the grid, and every framework constructs one
differently. Three shapes cover the whole catalog:

| Shape | Seen in | Edit |
|---|---|---|
| `<HotTable …>` | React | add or replace `theme={customTheme}` |
| `<HotTable …>` in an SFC | Vue, Nuxt | add or replace `:theme="customTheme"` |
| `new Handsontable(el, { … })` | JavaScript, TypeScript, Astro | add `theme: customTheme` |
| `gridSettings = { … }` | Angular | add `theme: customTheme` |

**Where the import goes is a second question, answered per file type** (DEV-2197).
A plain module takes it on the first line. A `.vue` SFC does not: an import above
the blocks is not a valid SFC at all, so it goes inside `<script>` — and under
the Options API it also needs a `setup()` returning `customTheme`, because only
`<script setup>` exposes its imports to the template. A `.astro` component keeps
the import in the client `<script>` that builds the grid; frontmatter runs on the
server and never reaches the browser.

The vanilla shape is found by scanning to the call's top-level comma rather than
by regex, because both of these are ordinary and a regex wide enough for the
first is wide enough to swallow the wrong comma:

```js
new Handsontable(document.getElementById('x'), { … })   // an expression, not an identifier
new Handsontable(container, hotOptions)                  // settings by name, wired at their declaration
```

### The container's CSS theme has to come off

A theme *object* is honoured **only when the container carries no `ht-theme-*`
class** — and unlike the `theme`/`themeName` pair, Handsontable says nothing when
it does:

```js
} else if (isRootInstance(instance) && !rootContainerThemeClassName && isObject(theme)) {
  initializeThemeManager(theme);   // core.js
```

Five starters wrap their grid in `<div class="ht-theme-main">` — vue, next.js,
astro, nuxt, remix — and every one of them ignored the panel outright until
DEV-2197. So wiring takes the class off and the marker comment carries it back
for **Reset**, exactly as it already does for a displaced `themeName`.

Passing the theme by *name* instead is not a way out: `StylesHandler.useTheme`
requires an `ht-theme-*` name and reads stylesheet variables, never the JS
registry, so a registered theme handed over as a string is a class with no CSS
behind it.

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

Asking is not enough, so a ramp that arrives incomplete is completed before it
is returned (`workers/api/src/theme-ramp.ts`, DEV-2197). The missing steps
otherwise deep-merge from the preset, leaving one preset-blue rung in the middle
of a navy ramp — and the whitelist above can produce the same symptom on its own
by dropping a single malformed value, which no prompt wording protects against.
Gaps are interpolated in sRGB, matching the panel's own brand-ramp generator
(`StylePanel.tsx` `rampFrom`); a ramp with fewer than two steps is left alone,
because one step is a deliberate single-colour change.

## Configuration

None of its own: it uses the same `LITELLM_API_KEY` as the assistant. Without
it the panel works fully and only "Describe a style" reports being
unconfigured.
