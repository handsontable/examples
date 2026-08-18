# Build a demo in the browser

**Who this is for:** support and solution engineers — anyone answering "can
Handsontable do this?" with a working grid instead of a paragraph. Everything here
happens in the browser, needs no editor and no build tools, and ends in a link you
can paste into the ticket.

Sign in first (bottom-right of the status bar, `@handsontable.com` only). Browsing
works without it; saving and sharing do not.

## 1. Pick a starting point

The **example picker** in the top bar holds three kinds of thing:

- **Blank templates** — first in the list. An empty 5x5 grid and nothing else: no
  sample data, no plugins switched on. Start here when you want to build something up
  deliberately; the **Create** tile in My demos goes straight there.
- **Framework starters** — JavaScript, TypeScript, React, Vue, Angular, Next.js,
  Nuxt, Astro, Remix, and the UI-library combinations (MUI, Ant Design, Fluent UI,
  Base Web). These are the full showcase examples: a lot is already switched on.
- **Documentation examples** — every example from the Handsontable guides, searchable
  by name. The search box at the top of the picker searches all of them at once.

![The example picker open, blank templates first, with every documentation category searchable beside it](/guide/example-picker.jpg)

*Blank templates first, then the framework starters; the search box searches every
documentation example at once.*

For a customer question, the documentation examples are usually the shortest path:
the example that proves the feature already exists, so your job is to relabel it with
the customer's columns rather than write it.

## 2. Choose a Handsontable version

The **Handsontable <version>** control in the preview bar renders the open demo at any
published version. Switching re-pins the demo's dependencies; your edits are kept, and
if the code uses an API that version does not have, the preview says so rather than
pretending.

Pick the version the customer is actually on. If they are on something old and the
answer is "this is fixed in a later release", show both: one demo on their version,
one on the current one.

The pencil beside the control also accepts unreleased builds — a nightly, or a
specific pull request. That is a developer's tool and it lives in the
[Developers track](/guide/developers); you will rarely need it, but it is the reason
support and engineering can look at the same URL.

## 3. Edit the demo

**Files** (left) lists everything in the project. Click a file to open it; the preview
updates as you type — immediately for the in-browser frameworks, a couple of seconds
for the server-based ones (Next, Nuxt, Astro, Remix, Angular), which rebuild in a real
dev server.

Signed in, Files also lets you:

- **Add a file** with the `+` button, or a file in a new folder with the folder button.
- **Drop files in.** Drag one or many text files — a whole folder, or a **`.zip`** —
  onto the Files panel. The panel outlines itself and tells you which directory the
  drop will land in; drop on a folder row to go inside it. Existing paths ask before
  they are replaced.
- **A zip is unpacked for you.** This is the forum case: somebody attaches an archive
  of the project that does not work for them, and dropping it straight in gets you
  their code running here, at any version you like. If everything sits under one
  folder inside the archive, that folder is stripped — you get `src/index.js`, not
  `their-project/src/index.js` — and every entry faces the same rules as a loose
  file, so a `.env`, a binary or a `node_modules` inside the zip does not come along.
  The other direction is **Download**: the whole workspace as a `.zip`, which is how
  you answer with "here is exactly what I ran".
- **Rename or delete** a file from the row's own controls.
- **Download** the whole workspace, including your edits, as a `.zip`.

Two things the drop will refuse, on purpose. **Binaries** — images, fonts, videos,
archives — because a demo's files are text all the way through to the build, so there
is nowhere for them to live; use a URL to an already-hosted image, or inline it as a
data URI in the CSS. And **`.env` files**, always, because a demo is one Save away
from a public link.

![The Files panel outlined mid-drag, with the hint "Drop into the project root"](/guide/files-drop.jpg)

*Mid-drag: the panel outlines itself and names the directory the drop will land in.*

Nothing is persisted until you **Save** (a demo you own) or **Fork** (a new one).

## 4. Send us a fiddle? Import it

**My demos → Import** takes a **JSFiddle** or **StackBlitz** URL and opens it here as
an editable workspace, unsaved, for you to review and save. This is the fastest way to
deal with "here is my reproduction" — you get the customer's code running on our
version picker, where you can bisect it.

- **JSFiddle**: its HTML, CSS and JS panels become `index.html`, `style.css` and
  `script.js`, and the libraries it loaded from a CDN are converted into real
  dependencies, so the demo follows the version picker instead of relying on script
  tags the bundler cannot see. If it used something we do not recognise, the import
  says so rather than dropping it quietly.
- **StackBlitz**: the project's files come across as they are, minus build output,
  lockfiles and binaries.
- **CodeSandbox cannot be imported.** It blocks automated reads of its projects. Use
  *File → Export to ZIP* there and drop the zip onto the Files panel.

![The Import a project dialog with a field for a JSFiddle or StackBlitz URL](/guide/import-dialog.jpg)

*My demos → Import. The project opens unsaved, so nothing is created until you Save.*

Only projects that actually use Handsontable can be imported: an import with no
`handsontable` dependency, no import of it and no CDN tag is refused, with that
explanation.

### From the Theme Builder

The **Theme Builder** has an *Open in playground* button instead of a URL to paste: it
hands its generated project straight over, with the theme already applied. That link
is good for **24 hours** — **Save** turns it into a real demo of yours, and after that
the demo's own URL is the one to keep.

## 5. Or start from someone else's demo

**All demos** lists everything the team has published, and the **Owner** dropdown
filters it to one person — the filter is in the URL
(`/all-demos?owner=marek-martuszewski`), so you can paste the filtered view to
somebody.

![All demos with the Owner dropdown open, listing each teammate and their demo count](/guide/all-demos-owner-filter.jpg)

*All demos, filtered by owner — counts per person, and "Everyone" to go back.*

- **Open** takes you to the read-only playground: read the code, try changes,
  download a `.zip`.
- **Copy link** gives you the client link, ready to send.
- **Fork** gives you your own editable copy.

Rename, save and delete stay with the owner, and an `/edit/` link to a demo that is
not yours opens the read-only view instead. So checking whether the answer already
exists costs nothing.

## 6. Ask AI, and the Style panel

- **Ask AI** answers questions about the open example — what it does, what an option
  means — grounded in the Handsontable documentation, with links. If it suggests a
  code change it *proposes* it; you apply it or you don't. Nothing is written behind
  your back, which makes it safe to use on a call.
- **Style** is the Theme Builder's controls applied to the demo you have open: colours,
  density, borders. It writes a real theme module into the demo, so what you share is
  the styling you see. Useful when the question is "will it look like our app?".

![The Style panel changing a grid's token mapping, icon set and density while the preview restyles itself](/guide/style-panel.gif)

*Recorded in the playground: three token mappings and an icon set, applied live to a
100,000-row grid. The theme is written into the demo, so the styling travels with the
link.*

![The Ask about this example panel, with suggested questions about the open demo](/guide/ask-ai.jpg)

*Ask AI is scoped to the code you have open — not Handsontable in general.*

## 7. Title and description

The pencil in **Box info** (top of the sidebar) edits the demo's **title** and
**description**.

Title says what the demo shows — "Invoice grid with validation", not "React demo".

The description is **markdown**, and you never have to type the syntax: the toolbar
does bold, italic, code, links, bullet and numbered lists and a heading, ⌘B / ⌘I work
as you would expect, and **Preview** switches the field to the rendered result. It
renders in the sidebar, on the demo card in My demos, and on the shared page — so it
is the right place for what the demo shows, the caveat you would otherwise say out
loud, and a link back to the ticket. Up to 4,000 characters, and the field tells you
when you are near the limit.

![The Edit info dialog: a title field and a markdown description with a formatting toolbar](/guide/description-write.jpg)

*Writing: the toolbar puts the markdown in for you.*

![The same dialog with Preview on, showing the description rendered as formatted text](/guide/description-preview.jpg)

*Preview: exactly what the sidebar, the demo card and the shared page will show.*

Write it even when you are in a hurry. The demo will outlive the conversation, and in
three months it is the description that tells you whether it is still the right link
to send.

## 8. Save, fork, share

- **Save** (on a demo you own) writes your edits and rebuilds the shared page.
- **Fork** takes whatever is open — a starter, a docs example, someone else's demo, an
  import — and makes it a new demo owned by you.
- **Share** gives you the links. For a customer, that is the **client link**
  (`/d/<id>/`): a permanent static page, safe to send, and it costs nothing to keep
  online because it is built once rather than run live. If they want to read the code,
  send `/share/<id>` instead.

![The Share this demo dialog listing the client link, the full-window link and the docs embed URL](/guide/share-dialog.jpg)

*Share, on a demo you own. Each field has a copy button.*

Check the client link opens before you paste it into the ticket. A 404 means the build
failed — reopen `/edit/<id>`, press Save and read the error.

## 9. My demos, and taking a link back

**My demos** lists everything you have created: open, copy the link, rename, fork, or
delete. **Deleting revokes the link** — the client page starts answering "revoked",
and it cannot be undone. Revoked demos stay in your own list with their badge, so you
can see what happened to a link you shared.

There is no way to un-revoke, and no way to edit a demo out from under a link you
have already sent — a Save updates the same link, which is usually what you want, so
if a customer must keep seeing the old version, fork instead of saving.
