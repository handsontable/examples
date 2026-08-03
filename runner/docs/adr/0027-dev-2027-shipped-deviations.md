# ADR-0027: DEV-2027 — where the shipped UI deliberately departs from the frames

**Status:** Accepted

## Context
ADR-0023 set the redesign's scope rules and ADR-0025 corrected three of its applied decisions after
the Figma **After Login** section landed. Neither records the individual places where the shipped
implementation knowingly differs from a frame.

Those calls were logged in `dev-2027-redesign-plan.md`, a working document retired once the redesign
shipped (DEV-2172). Each entry below is a decision someone will otherwise re-open on the assumption
it was an oversight — most of them look like bugs against the design until you know why. Recorded
here so the frames can be compared against the app without re-deriving the reasoning.

Cosmetic items that only ever wanted one line of confirmation from design were dropped rather than
carried across. Unresolved questions and known bugs became their own tasks; see *Consequences*.

## Decision
Each departure below stands as shipped.

### Chrome and layout

**1. `Download` is unconditional; the mode slot holds `Fork` / `Save` only.** ADR-0025 placed `Save`
in "the same mode-keyed slot that holds `Fork` when the demo is not yours and `Download` when it
is". That was inferred from the frames, and implementing it literally would **remove `Download` in
`play`** — a behaviour regression dressed as a restyle, against ADR-0023 rule 1. `TopBar.tsx`
renders `Download` whenever `onDownload` is set; a new mode slot left of the theme toggle carries
`Fork` in `play` and `Save` in `edit`.

**2. Anonymous visitors keep `Download`.** `72:15697`'s top-right group is theme toggle + `Sign in`,
127px, with no `Download`. It works for anonymous visitors today and a frame omitting it is not an
instruction to remove it (ADR-0023 rule 1). The sidebar's FILES header carries the same zip in every
mode anyway. One-line change if design wants the frame followed exactly:
`onDownload={user ? downloadZip : undefined}`.

**3. The version pencil sits after the pill's chevron, not inside it.** `114:24396` draws
`tabler-icon-pencil` adjoining the chevron inside the pill's frame. `MenuButton`'s chevron is the
last child of the trigger `<button>`, so a pencil rendered before it would be a nested interactive
that opens the menu on click. The visual cost is nil — `s.menuButton` has `border: none` and a
transparent background, so there is no box at rest for the pencil to fall outside of. Worth
revisiting only if the pill gains a border.

**4. Tier 1 shows a `Live preview` placeholder where the frames show a URL.** The row-2 address
field shows the demo's public URL when it has one — always `/share/:id`, never `/edit/:id`, since
the field is click-to-copy and `/edit` is auth-gated. Tier 2 gives the container's preview origin.
Tier 1 cannot: `SandpackRuntime.mount` returns Sandpack's *bundler* origin
(`https://…sandpack.codesandbox.io/`), which is both meaningless to the user and a CodeSandbox mark
that ADR-0001 keeps out of the UI.

**5. `Recipes` is promoted to its own left-column section.** `72:18037` draws one flat column of 15
categories. The manifest does not fit that shape: 152 examples carry a three-segment breadcrumb, all
under `Recipes`, against 1,250 at two segments. A flat `Recipes` row would need a third column,
breaking the 480px popover width the design is explicit about. Recipes' 12 sub-categories are
promoted beneath a `RECIPES` label instead, so every category resolves to exactly one level of
headers. Two consequences: four sub-categories share a name with a documentation category (keys are
namespaced `Recipes|Cell Types`; the section label is the only visual disambiguator), and 28
categories against the design's 512px column means the column scrolls, which the design does not
show. The design's `Optimilzation` and `Recipies` are Figma typos; the shipped UI uses the manifest's
`Optimization` and `Recipes`.

**6. The status bar's `Spaces: 2` / `UTF-8` / `Layout: U.S.` are static labels.** Only `Ln n, Col n`
has a live source. `indentUnit` lives in `@codemirror/language`, which `@uiw/react-codemirror`
neither re-exports nor depends on, and `EditorState.tabSize.of(2)` would only change how a literal
tab renders — our files are space-indented, so it would buy nothing observable while implying the
label is derived. Encoding and keyboard layout have no source at all in a browser.

**7. The search placeholder stays `Search examples…`.** `72:18031` labels it `Search ...`. The
string is also the input's accessible name, where "examples" says *what* is being searched, and
three specs bind to it. Trivially changed if design wants the shorter string — but `aria-label`
should then keep the longer one.

### Behaviour

**8. Revoked demo cards stay visible, with no kebab.** `DELETE /api/demos/:id` has never
hard-deleted; it sets `revoked=1`, `/d/:id` starts answering 410, and there is no unrevoke. Every
card in `114:25521` is live — the design has no muted or archived variant. Revoked cards render at
`opacity: 0.55` with a `danger`-bordered badge and **no kebab at all**, because every action needs
something the revoke took away: `getDemoSource` returns null, so Open and Rename both land on "This
demo is unavailable"; Copy link hands out a URL that 410s; Fork has no source; Delete already
happened. An earlier cut kept Rename, which was a dead end — a menu of dead ends is worse than no
menu. A hard-delete endpoint was considered and rejected: `forked_from` stores demo ids, R2
artifacts are never cleaned up, and already-revoked rows would need a migration story. That is a
data-lifecycle decision, not a redesign one.

**9. `/share/:id` shows a signed-in visitor their own account menu.** `App.tsx` hardcodes
`user={null}` on the share route, correctly — the page is public and read-only — and before T9 the
top bar keyed off the same value, so a signed-in user opening a colleague's share link was offered
**Sign in** while holding a live session. `ShareRoute` now resolves identity separately as
`accountEmail`; `authed` still gates the authed actions and stays `false`. **The resolve has three
states, not two**: `currentUser()` round-trips the external broker, so seeding `null` would mean
"anonymous, confirmed" for a few hundred milliseconds and re-introduce the bug briefly. `undefined`
is pending, and `accountPending` withholds `onSignIn`, so that window renders neither control rather
than the wrong one.

**10. The share dialog's full-window label was rewritten.** `114:23289` labels the middle row
"Full-window (example only — embed in any iframe)". Both halves are false as shipped: `?mode=full`
carries the design's own chrome (top bar, URL bar, status bar), and it cannot be embedded at all —
the page iframes `/d/:id/`, which sends `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`, so
a third-party ancestor is blocked. Shipping the copy verbatim would have pointed anyone wanting a
bare embed at the one URL that cannot do it. ADR-0023 rule 1 is about not deleting working
functionality for want of a frame; it does not oblige shipping copy that contradicts the code.
Ships as "Full-window (the demo without the editor)". **The frame's wording may be a request** — a
genuinely embeddable chrome-less URL — rather than a description of today. If so that is a feature.

**11. The open-tab set is not persisted across a reload.** Undesigned — no frame shows a returning
session — so ADR-0023 rule 1 applies. The entry file alone reopens on load, which is what the app
did before multi-tab. Persisting the set means choosing a scope (per demo? per example? per
browser?) and a home, and the `play` playground has no identity to key it by.

**12. No `Cmd/Ctrl+W` or `Ctrl+Tab` on the tab strip.** The two shortcuts drawing tabs implies, and
both are browser-reserved: Chrome closes the browser tab and cycles browser tabs respectively,
neither interceptable by a page. Hijacking the first would also be hostile — a user who means to
close the browser tab and loses the keystroke to the editor has no way to tell what happened.
Delete/Backspace closes the focused tab instead.

## Consequences
- The frames and the app differ in twelve known places. A future comparison should start here rather
  than filing each as a defect.
- Items 1, 2, 4, 7 and 10 are each a one-line change if design decides the frame should be followed
  literally. They are logged rather than guessed for that reason.
- Unresolved questions from the same working document became tasks rather than entries here, since
  an ADR records a decision made:
  - **DEV-2173** — design reconciliation. Dark `textMuted`, the four-step surface ramp against three
    painted surfaces, Figma `accent-color` `#4669f6` vs the shipped `#1A42E8`, accent-on-dark under
    WCAG AA, and the preview bar's overflow at a 320px column. Five items that each ask for one
    design call on the same token set — they want **one conversation, not five**.
  - **DEV-2174** — the Angular container ignores global `styles.css` edits. The push succeeds and a
    component edit in the same session applies in ~2s, so only stylesheet changes fail to reach the
    page.
  - **DEV-2175** — TypeScript docs examples boot with a `/src/main.js` entry against a `.ts` file.
    Same shape as DEV-2130.
  - **DEV-2176** — Tier-1's refresh may not recompile at all; `updateSandbox(setup, true)` goes
    unanswered, and if it no-ops with an unchanged file set then the refresh button does nothing.
- Cosmetic observations that only ever wanted a line from design were dropped with the working
  document: the `ejs` icon on two file rows, the active tab's left border, GitHub Dark sitting a step
  darker than `editorBg`, the category column's scrollbar, and the loading frame drawing chrome above
  a splash that has none to draw.

## Appendix — Figma frame index

ADR-0023 and ADR-0025 cite node ids without saying what they show. Section `18.1` of the
[Figma Sandbox file](https://www.figma.com/design/KCl2Csh9WUSwCrddffnYuD/Sandbox) (fileKey
`KCl2Csh9WUSwCrddffnYuD`).

| Node | Name | What it shows |
|---|---|---|
| `48:6560` | Light mode / Light example | Baseline fork/edit view, light chrome |
| `31:6438` | Fork preview — Dark mode / Dark example | Dark chrome, sidebar with nested `src/` |
| `65:21451` | Light mode / Dark example | **Mixed**: light chrome + dark grid |
| `65:19433` | Dark mode / Dark, system example | Sidebar collapsed |
| `65:23282` | Light mode / Light example | Light twin of `65:19433` — sidebar collapsed |
| `72:15697` | Example (before login) | Full toolbar: version + framework selectors, `Sign in` |
| `72:14610` | Example (before login, booting) | Loading state — spinner + "Loading data …" |
| `72:26445` | Example Refreash *(sic)* | Preview refresh in flight |
| `72:17078` | Search | Example-picker cascader popover |
| `65:20432`, `65:24280` | Mode Full | Preview-only mode; `65:24280` adds Download + theme |
| `65:17596` | Fork preview — Dark mode / Light example | BOX INFO chevron only, CRUD hidden |
| `72:11913`, `72:13670` | Mode Embed Docs | Bare grid, no chrome — light and dark |
| `85:9970`, `85:16935` | Resize | Splitter drag state, light + dark |
| `11:2471` | icons | seti-ui file-type icon sheet |

**After Login section (`114:*`)** — added to the file *after* the redesign subtasks were written,
which is the whole reason ADR-0025 exists.

| Node | Name | What it shows |
|---|---|---|
| `114:21146` | After Login Example | **Complete signed-in workspace** — `Fork` in the top bar, `share` in the preview bar, a pencil on the version pill, CRUD unhidden in the sidebar, a dirty dot on the active tab |
| `114:21480` | Menu | Account popover — My demos / Settings (greyed) / Log out |
| `114:23289` | Sahre links *(sic)* | Share dialog over the authed workspace |
| `114:24410` | Sandbox info edit | Edit-info dialog — Title, Description, Save / Cancel |
| `114:25521` | After Login Example | My Demos page — 320px nav, card grid, kebab, `+ Create` |
| `114:26833` | After Login Example | Settings page — Name, Description, avatar Upload / Remove |

Sticky notes carrying decisions:

- `11:2535` — code colours = same as docs, GitHub Theme Dark/Light
- `11:2545` — icons = tabler-icons + seti-ui (see ADR-0024)
- `72:16829` — book icon → docs page, github icon → example repo
- `72:14527` — embed iframe `body { margin: 0 }` → out of scope, `/embed/:id` dropped
- `72:14532` — no rename / delete / add file in the sidebar in "fork/view mode"
- `114:26599` — **"CRUD w sidebar po zalogowaniu"** (*CRUD in the sidebar after logging in*). Read
  with `72:14532`, this settles "fork/view mode" as meaning *not signed in* — the reconciliation
  ADR-0025 §2 rests on.
- `114:26732` — "this zone may grow: user management, folders…", beside My Demos' left nav.
  Forward-looking; confirms the 320px rail is meant as real navigation.
