# ADR-0034: The guide is four role-based tracks, not one document

- **Status:** accepted
- **Date:** 2026-08-14
- **Ticket:** DEV-2522 (subtask of DEV-2498; supersedes the single-document shape from DEV-2503)

## Context

`/guide` (ADR-less, DEV-2503) shipped as one markdown file — `docs/create-and-share-a-demo.md`
— rendered raw on one page. It grew as the runner did: blank starters, drag & drop,
imports, markdown descriptions, the `publish-demo` plugin, and finally headless
creation through the Handsontable MCP (ADR-0033). Thirteen numbered sections, and
every reader needed three or four of them.

The audiences turned out to be genuinely different, not differently-skilled:

- Somebody in sales or management wants **one sentence typed into Claude** and a link
  back. They will not open the playground at all.
- **Support** lives in the browser: starters, documentation examples, forking a
  colleague's demo, importing the customer's JSFiddle, dropping in files.
- **DevRel** cares about one thing the others never touch — a demo **embedded** in a
  documentation page or a blog post, and keeping it alive across releases.
- **Developers** need the two things nobody else should be shown by default: a demo
  built from an **unreleased pull request** (or a nightly), and publishing from a local
  project.

A single scroll served all four badly. Worse, it put PR builds and `iframe` snippets in
front of readers for whom they are noise, which is how a guide stops being read.

## Decision

**One route per audience, one markdown file per route.**

- `/guide` is an **overview**: what the site is, four track cards labelled by audience,
  the links every demo has, the URL cheat sheet, the ground rules, and the shared
  "when something looks wrong".
- `/guide/everyone` — non-technical, any team: ask Claude, through the MCP.
- `/guide/support` — every route available in the browser.
- `/guide/devrel` — embeds in the docs and on the blog.
- `/guide/developers` — PR and nightly builds, tiers, the plugin, what the runner accepts.

Content stays in `runner/docs/guide/*.md`, imported `?raw` — the DEV-2503 decision that
the reviewed markdown *is* the page, unchanged. `docs/create-and-share-a-demo.md` is
deleted rather than kept as a fifth copy; drift between a "full" document and the tracks
was the one failure mode worth designing out.

**Sections are addressable.** Every `##`/`###` heading gets a slug id, the track page
lists them in an "on this page" rail, and each row carries a copy-link button — the guide
is most useful when you can paste `/guide/support#7-title-and-description` at somebody
instead of retyping the steps.

**Anchor ids come from one function.** `apps/authoring/src/guideTracks.ts` derives them
from the markdown source (fence-aware, de-duplicated); the page hands `Markdown` the ids
**by document order** through a new `headingIds` prop. The renderer does not slug
anything itself, so the contents list and the rendered anchors cannot disagree.

**An unknown track renders the overview with a notice**, rather than a blank column or a
redirect that hides the typo — stale links are the normal cost of naming things.

**The tracks are navigated from the left panel**, not a tab strip inside the content.
`SideNav` grows a nested sub-list under Guide, drawn only when Guide is the current
page; the four sections sit where every other section of the account area sits, and the
"on this page" rail handles the second axis. A tab strip two lines below a sidebar
listing the same four things was the same list twice.

**The guide carries figures**, and the parser learned `![alt](/path)` to allow it. The
rule is deliberately narrower than links: **same-origin paths only, no `http(s)`**. The
figures are files the app ships (`apps/authoring/public/guide/*`), and the same renderer
draws model answers and user-written demo descriptions, where a remote `<img>` is a
request the reader never asked for — a tracking pixel in a description, or a
model-authored URL that leaks the page it rendered on. Images are `loading="lazy"` and
wrapped in a link to themselves, so a track you do not open costs nothing and a
screenshot too dense for a 700px measure opens full-size in the browser's own viewer.
A test asserts every referenced figure exists and has real alt text; the initial split
shipped without figures, which was the wrong call for a page people skim.

## Consequences

- Renaming a heading changes its anchor, and a link somebody pasted into Slack stops
  scrolling to the right place. Acceptable: `guide-tracks.test.mjs` pins the slug rules,
  so the breakage is a content decision rather than an accident.
- Deeplinks needed an explicit scroll. The page is empty until the identity resolves and
  React mounts, so the browser's own hash scroll finds nothing and gives up; `TrackView`
  scrolls to the named section after the prose exists. Covered by an e2e assertion that
  the heading is *in the viewport*, which is the only version of this that fails when it
  regresses.
- Internal markdown links (`/guide/...`) now render without `target="_blank"`, so the
  tracks can cross-reference each other without opening a tab per link. External links
  are unchanged.
- The published slide deck of the same material (screenshots, screencast) is a separate
  artifact and *will* drift. It is a presentation; `/guide` is the reference, and the
  overview says so.
- Four files are easier to keep honest than one: a test asserts each track owns its
  subject and that PR builds and `iframe` snippets appear on exactly one page each.
