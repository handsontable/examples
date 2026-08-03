# ADR-0026: Shell styling — inline component styles, interaction states in the global stylesheet

**Status:** Accepted

## Context
`packages/editor-shell` styles its components with inline `CSSProperties` objects exported from
`styles.ts`. That is deliberate: the package ships as TS source consumed directly by the app
(ADR-0015), with no build step and no CSS file of its own, so a component carries its own
appearance and cannot be broken by a stylesheet the consumer forgot to import.

Inline styles cannot express `:hover`, `:focus-within`, `::-webkit-scrollbar` or any descendant
selector. Those live in the app's global block in `apps/authoring/index.html` — `.hot-file-row`,
`.hot-icon-btn`, `.hot-casc-row`, `.hot-tab` / `.hot-tab-x` / `.hot-tab-dot`, `.hot-demo-card`.

Splitting one element's appearance across two mechanisms with different cascade rules produced the
same class of bug **at least four times** across DEV-2027 (T3, T9 twice, T12), each time silently:
the styling looked right, and only the interaction was dead. Recording the rule and the verification
procedure so it is not rediscovered a fifth time.

## Decision

**1. An element whose interaction state is styled from the stylesheet must not set that same
property inline.** An inline declaration outranks any stylesheet rule for the same property, so the
`:hover` rule becomes dead code. This holds for every value, **including `transparent`** — inline
`background: "transparent"` beats `.hot-file-row:hover { background: … }` just as a real colour
would.

**2. It is not only `background`.** Every property the hover changes has to stay out of the inline
object. Three that bit in practice:

- **`background`** — T3's file rows set `background: activeRow ? surfaceMuted : "transparent"`
  inline, killing the hover fill.
- **`color`** — the My Demos kebab's Delete row inverts to white-on-red; an inline `color: danger`
  left red text on the red fill.
- **The `border` shorthand** — `.hot-demo-card:hover { border-color: … }` was dead because the card
  set `border: 1px solid …` inline. The shorthand carries `border-color`, so it wins even though
  the rule names only the longhand.

**3. Both fills go in the stylesheet, base first and `:hover` second.** Equal specificity, source
order decides. Omitting the base declaration instead of moving it is *not* the fix: a `<button>`
with no `background` at all falls through to the user agent's `buttonface`, a light-grey slab in
both light and dark. That is how "Log out" came to read as the selected row in the My Demos nav.

**4. An element that is genuinely never hovered** — a disabled row — may keep an inline
`background: "transparent"`, since there is no rule for it to outrank.

**5. Verify a hover by measuring it, under a real pointer.**

- A synthetic `mouseover` event does **not** trigger CSS `:hover`. Use a real pointer move
  (Playwright's `hover()`), then read `getComputedStyle`.
- **Wait out the transition before reading.** These elements carry
  `transition: background-color 0.12s ease`, and `getComputedStyle` returns the *currently
  animating* value, not the target. Read immediately after `hover()`, a perfectly live rollover
  reports its resting colour — T12 measured `rgba(0, 0, 0, 0)` on a working tab, then
  `rgba(120, 130, 150, 0.008)` on the retry, which is `--hot-color-hover` 5% of the way through its
  own transition. Properties with no transition (a `display` swap) can be read immediately.
- **Move the pointer off the element before reading the resting value**, or the hover fill masks it.
- Comparing rest against hover is the assertion. Eyeballing a screenshot cannot distinguish a
  subtle live hover from a dead one, and asserting only that a row-action *appears* does not
  either — T3's reveal worked throughout, because `opacity` was never set inline.

## Consequences
- Any new hoverable element in the shell needs a class in the app's global block, not just a style
  object. This is the cost of the package owning no CSS file, and is accepted.
- The shell and the app are coupled through class names. A consumer other than `apps/authoring`
  would have to ship the same block; there is only one consumer today (ADR-0015).
- The universal rollover in `apps/authoring/index.html` — `filter: brightness(0.92)` on every
  `button` and `a` — applies to shell buttons too, including ones no frame asks to change on hover
  (an active editor tab dims because a tab is a button). Left as-is: it is the treatment every
  other button in the app already gets. Replacing it with per-element hovers is a design call.
- Tests that assert an interaction state must run a real pointer and read computed style. That is
  slower than a DOM assertion and is the only thing that catches this bug class.
