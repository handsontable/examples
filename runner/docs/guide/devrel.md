# Demos in the documentation and on the blog

**Who this is for:** DevRel, docs and marketing — anyone putting a running
Handsontable example inside a page we publish. A demo here is a better artefact than a
code block: it runs, it is pinned to a version, and it can be changed without
redeploying the docs.

Everything in the **Support** track applies to building the demo. This page is about
the part that comes after: getting it into a page, and keeping it working.

## The embed URL

**Share → Docs embed URL** gives you `https://demos.handsontable.com/embed/<id>/`.

It renders the demo with no editor chrome at all — no file tree, no version pill, no
top bar — because it is meant to sit inside your layout, not to look like a tool.

It **only renders inside `handsontable.com`** (plus the docs' staging site, and
`localhost` while you are working). Anywhere else the browser refuses to draw it and
the frame stays blank. That is the frame lock doing its job: the client link is for
sending to people, the embed is for our own pages.

## Putting it in a page

```html
<iframe
  src="https://demos.handsontable.com/embed/ab12cd34/"
  title="Sorting a large dataset"
  width="100%"
  height="520"
  style="border: 1px solid #e5e7eb; border-radius: 6px"
  loading="lazy"
></iframe>
```

Three things about size:

- **You choose the height.** An `iframe` has no natural one, and the demo does not tell
  the page how tall it wants to be, so whatever you set is what you get.
- **About 500px is a sensible start** for a demo that is one grid: the grid brings its
  own height from the example's code, and the page around it adds roughly a centimetre
  of padding. If the demo ends up with its own scrollbar, the frame is shorter than the
  grid — raise the height rather than changing the demo.
- **Width is safe at `100%`.** The demos are laid out for whatever width they are
  given.

Always set a `title`: it is what a screen reader announces instead of "iframe", and
the one accessibility detail an embed can get wrong on its own.

## The read-only playground, for "show me the code"

`/share/<id>` is the demo in the full editor, where a reader can read every file, try
changes and download a `.zip`, but cannot save over yours or change its version. In an
article, that is the link for "open this in the playground" under an embed — the embed
shows the result, the playground shows how.

The **client link** (`/d/<id>/`) cannot be framed at all, on any site. Use it in prose,
never in an `iframe`.

## Full-window preview, for screenshots and recordings

`/?mode=full` renders the preview alone with no editor chrome, at whatever window size
you give it. It works on any starting point, which makes it the tool for a clean
screenshot or a screen recording:

```
https://demos.handsontable.com/?docs=guides/rows/row-sorting/react/example1.tsx&v=18.0.0&mode=full
https://demos.handsontable.com/share/ab12cd34
```

A demo of your own is easier to keep consistent across a series of images than a docs
example, because you control its data and its theme.

## Pin the version the article was written against

Every URL takes `&v=`, and a saved demo remembers its own version. An article that
says "as of 18.0" should embed a demo pinned to 18.0 — otherwise the prose and the
grid drift apart at the next release, and the reader is the one who finds out.

When a release changes what the article describes: fork the demo, bump the fork, and
update the article. The old demo keeps serving the old article, which may still be
live on an older docs branch.

## Documentation examples as the starting point

Any example from the guides opens here directly:

```
https://demos.handsontable.com/?docs=guides/columns/column-adding/react/example1.tsx
https://demos.handsontable.com/?docs=…&v=17.1.0
```

Fork it, extend it into something that carries the article's story — realistic columns,
a plausible dataset, the feature you are writing about switched on and everything else
off — and embed the fork. The docs example is the skeleton; a demo people remember has
one clear idea and no distractions.

If a `?docs=` link answers "unavailable for *x.y.z*", that example does not exist for
the version you asked for. Examples travel with their version.

## Styling a demo to match the page

**Style** applies the Theme Builder's controls to the open demo — token mapping, icon
set, colours, density, borders — and writes a real theme module into the project, so
the styling travels with the demo into the embed and into any `.zip` a reader
downloads. **Copy for my app** gives the same theme as code, which is what a reader
asking "how do I make it look like your docs?" actually wants.

Match the docs' own surface, not the default: an embed that carries a different grey
than the page around it reads as a screenshot rather than part of the article.

## The description is the caption

The demo's markdown description shows on the shared page and on the demo card — not
inside the embed. Write it for the person who arrives at the demo *without* your
article: what it shows, which version, and a link back to the page it belongs to. That
link is what makes a stray demo traceable a year later.

## Keeping an embedded demo alive

- **Never delete a demo that is embedded.** Deleting revokes it: the embed goes blank
  and the client link answers 410, and it cannot be undone. If a demo is wrong, fix and
  Save it — the same link keeps working.
- **Saving is safe, and immediate.** The shared page rebuilds on Save, so a typo fix
  reaches every page that embeds it without touching the docs.
- **Forks are how you make variants** — one per framework, one per article — instead of
  one demo whose meaning depends on which page you found it on.
- **Ownership matters.** Only the owner can save; if the demo needs to outlive one
  person's involvement, own it from a shared context or make sure DevRel has a fork.

## Before you publish

- The embed renders on a staging build of the page, at the width the article uses.
- The height shows the whole grid without an inner scrollbar.
- The `iframe` has a `title`.
- The demo is pinned to the version the prose claims.
- The description names the article, so the demo can be traced back.
- The data is invented, and nothing on screen belongs to a customer.
