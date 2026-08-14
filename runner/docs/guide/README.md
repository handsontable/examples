# The in-app guide

These files *are* `/guide` on demos.handsontable.com. The page imports them raw and
renders them with the app's own markdown renderer, so a PR against a file here is
the only way the guide changes — there is no second copy inside a `.tsx`.

One file per audience, because the four teams need four different pages and a
single document made everyone scroll past three quarters of it (DEV-2522):

| File | Route | Who reads it |
| --- | --- | --- |
| `overview.md` | `/guide` | everyone, once — what the site is, the URL cheat sheet, what to do when something looks wrong |
| `everyone.md` | `/guide/everyone` | anyone on the team, non-technical: ask Claude for a demo and get a link back |
| `support.md` | `/guide/support` | support and solution engineers: every route you can take in the browser |
| `devrel.md` | `/guide/devrel` | DevRel and docs: demos embedded in the documentation and on the blog |
| `developers.md` | `/guide/developers` | developers: demos from an unreleased PR, from a nightly, and from your own project |

Two conventions the page depends on:

- **`overview.md` has no `#` heading.** The overview page draws its own title and
  the four track cards above it. Every other file opens with one `#` heading, which
  becomes that track's page title.
- **`##` and `###` headings become deeplink anchors** — slugified from the heading
  text by `apps/authoring/src/guideTracks.ts`. Renaming a heading changes its
  anchor, so a link someone pasted into Slack stops scrolling to the right place.
  Rename freely, but know that is the cost.

The published slide deck of the same material (screenshots, screencast) is a
separate artifact; it is a presentation, and this is the reference.
