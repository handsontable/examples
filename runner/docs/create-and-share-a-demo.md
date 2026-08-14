# Using demos.handsontable.com

Everything the Handsontable team can do on the demo runner, in the order you are
likely to need it. Non-technical by design — nothing here requires a checkout.

This page is also the in-app guide: signed-in users reach it from the account menu
or at **/guide**, rendered from this same file. If you change one, you change both.

## What this site is

A live playground for Handsontable. Every example runs for real in the browser,
you can edit the code and watch it change, and you can turn any of it into a
permanent link to send to a client or embed in the docs.

Browsing and editing are **open to anyone** — no sign-in. Signing in
(`@handsontable.com` only) is what adds saving, sharing and My demos. The
**Sign in** link sits at the bottom-right of the status bar, next to the version
readout; it is deliberately quiet, because most visitors here are not on the team.

## 1. Pick a starting point

Use the **example picker** in the top bar. It holds three kinds of thing:

- **Blank templates** — first in the list. An empty 5x5 grid and nothing else: no
  sample data, no plugins switched on. Start here when you want to build something
  up deliberately; the **Create** tile in My demos goes straight there.
- **Framework starters** — JavaScript, TypeScript, React, Vue, Angular, Next.js,
  Nuxt, Astro, Remix, and the UI-library combinations (MUI, Ant Design, Fluent UI,
  Base Web). These are the full showcase examples.
- **Documentation examples** — every example from the Handsontable guides, searchable
  by name. The search box at the top of the picker searches all of them at once.

## 2. Choose a Handsontable version

The **Handsontable <version>** control in the preview bar renders the open demo at
any published version. The pencil beside it takes an exact build — a nightly like
`0.0.0-next-07941cf-20260708`, or a `pkg.pr.new` preview of an unreleased PR.

Switching version re-pins the demo's dependencies. Your edits are kept; if the code
uses an API that version does not have, the preview says so rather than pretending.

## 3. Edit the demo

**Files** (left) lists everything in the project. Click a file to open it; the
preview updates as you type — immediately for the in-browser frameworks, a couple
of seconds for the server-based ones (Next, Nuxt, Astro, Remix, Angular), which
rebuild in a real dev server.

When you are signed in, Files also lets you:

- **Add a file** with the `+` button, or a file in a new folder with the folder
  button.
- **Drop files in.** Drag one or many text files — or a whole folder — onto the
  Files panel. The panel outlines itself and tells you which directory the drop
  will land in; drop on a folder to go inside it. Images and other binaries are
  refused with a message, because a demo's files are text all the way through to
  the build. `.env` files are never accepted.
- **Rename or delete** a file from the row's own controls.
- **Download** the whole workspace, including your edits, as a `.zip` — the
  download button in the Files header, or the one in the top bar.

Nothing is persisted until you **Save** (an existing demo) or **Fork** (a new one).

## 4. Import a demo from somewhere else

**My demos → Import** takes a **JSFiddle** or **StackBlitz** URL and opens it here
as an editable workspace, unsaved, for you to review and save.

- JSFiddle: its HTML, CSS and JS panels become `index.html`, `style.css` and
  `script.js` — and the libraries it loaded from a CDN are converted into real
  dependencies, so the demo follows the version picker and runs in the preview
  instead of relying on script tags the bundler cannot see. If it used something we
  do not recognize, the import says so rather than dropping it quietly.
- StackBlitz: the project's files come across as they are, minus build output,
  lockfiles and binaries.
- **CodeSandbox cannot be imported.** It blocks automated reads of its projects.
  Use *File → Export to ZIP* there, unpack it, and drag the files onto the Files
  panel instead.

Only projects that actually use Handsontable can be imported — this playground
hosts Handsontable demos, and an import that has no `handsontable` dependency, no
import of it and no CDN tag is refused with that explanation.

### From the Theme Builder

The **Theme Builder** has an *Open in playground* button instead of a URL to paste:
it hands its generated project straight over and opens it here as `/?payload=<id>`,
again unsaved and editable, with the theme you built already applied.

That link is good for **24 hours** — long enough to come back to it tomorrow, not a
place to keep anything. **Save** turns it into a real demo of yours, and after that
the demo's own URL is the one to keep. Opening an older link says it has expired;
generating a new one from the Theme Builder is the fix.

## 5. Publish a demo from your own machine

If the example already exists in a folder on your computer, the **publish-demo**
Claude Code plugin does the fiddly half of this page for you: it works out which
starter matches your project and which Handsontable version it pins, stages a
clean copy of the files (leaving out `node_modules`, build output, lockfiles,
binaries and anything called `.env`), opens the runner with the right starter and
version already selected, and checks afterwards that the demo actually built.

Install it once:

```
claude plugin marketplace add handsontable/claude-plugins
claude plugin install publish-demo@handsontable
```

Then, in Claude Code, in the folder with your example:

```
publish this demo
```

…or `/publish-demo:publish-demo` to invoke it directly. It will hand you the
prepared folder to drop onto **Files**, and the client link at the end.

Two things worth knowing. It is **not** a one-command upload: signing in here is a
Google login in the browser, so the drag step is real — the plugin removes
everything around it, not the login itself. And there is a sibling plugin,
**publish-app**, for a different job: an *application* with a backend, a login or
its own storage gets its own Cloudflare Worker and belongs there. Examples — a
grid, its data, and the code that configures it — belong here.

## 6. Ask AI, and the Style panel

- **Ask AI** answers questions about the open example, with links into the
  documentation. If it suggests a code change it *proposes* it — you apply it, or
  you don't; nothing is written behind your back.
- **Style** is the Theme Builder's controls applied to the demo you have open:
  colors, density, borders. It writes a real theme module into the demo, so what
  you share is the styling you see. You can also describe a look in words and let
  it generate the theme.

## 7. Title and description

The pencil in **Box info** (top of the sidebar) edits the demo's **title** and
**description**.

The description is **markdown**, and it can be several paragraphs. You never have
to type the syntax: the toolbar above the field does **bold**, _italic_, `code`,
links, bullet and numbered lists and a heading, and ⌘B / ⌘I work as you would
expect. **Preview** switches the field to the rendered result — the same rendering
the demo pages use, so what you see there is what they will show.

It renders as formatted text in the sidebar, on the demo card in My demos, and on
the shared page, which makes it the right place for "what this demo shows",
caveats, or a link back to the ticket. Long descriptions are clamped in the sidebar
with a **Show more** toggle, so a detailed one never pushes the file tree off the
screen. The limit is 4,000 characters, and the field tells you when you are near
it.

## 8. Save, fork, share, embed

- **Save** (on a demo you own) writes your edits and rebuilds the shared page.
- **Fork** takes whatever is open — a starter, a docs example, someone else's
  demo, an import — and makes it a new demo owned by you.
- **Share** gives you the two links:
  - **Client link** — `…/d/ab12cd34/`. A permanent static page, safe to send to a
    client. It keeps working and costs nothing to keep online, because it is built
    once rather than run live.
  - **Docs embed URL** — `…/embed/ab12cd34/`. For embedding a demo in the
    Handsontable documentation; it only renders when embedded on
    `handsontable.com`.
- **Share playground** — `…/share/ab12cd34/`. The demo in the full editor, where
  anyone with the link can read the code, try changes and download a `.zip`, but
  cannot save over it or change its version.

### Putting the embed on a page

The embed URL goes in an `iframe` on a `handsontable.com` page:

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

Three things to know about the size. **You choose the height** — an `iframe` has
no natural one, and the demo does not tell the page how tall it wants to be, so
whatever height you set is the height you get. **Around 500px is a sensible
start** for a demo that is one grid: the grid brings its own height from the
example's code, and the page around it adds about a centimetre of padding.
**Width is safe to leave at `100%`**; the demos are laid out for whatever width
they are given. If the demo ends up with its own scrollbar, the frame is shorter
than the grid — raise the height rather than changing the demo.

The embed only renders inside `handsontable.com` (and the docs' staging site, and
`localhost` while you are working). Anywhere else the browser refuses to draw it
and the frame stays blank — that is the frame lock doing its job, not a broken
demo. The **client link** cannot be framed at all, on any site: if you need
something embedded, use the embed URL.

## 9. My demos

**My demos** (account menu) lists everything you have created: open, copy the
link, rename, fork, or delete. Deleting revokes the link — the client page starts
answering "revoked" — and it cannot be undone.

**All demos** shows the whole team's, so you can see what other people have built.
Someone else's demo is read-only for you: **Open** takes you to the read-only
playground (read the code, try changes, download a `.zip`), and you can **Copy
link** or **Fork** it — forking gives you your own copy to change. Rename, delete
and save are the owner's alone, and an `/edit/` link to a demo that is not yours
opens the read-only view instead. Revoked demos stay in your own list, with their
badge, so you can see what happened to a link you shared; they do not clutter
anyone else's.

## 10. Useful URLs

Anything you can reach by clicking, you can also link to directly:

| URL | Opens |
|-----|-------|
| `/?example=blank` | a blank template |
| `/?example=react` | a framework starter |
| `/?docs=guides/columns/column-adding/react/example1.tsx` | a documentation example |
| `/?v=17.1.0` | the same page at a chosen version (combines with the above) |
| `/?import=<url>` | the import flow for a JSFiddle or StackBlitz URL |
| `/?payload=<id>` | a project handed over from the Theme Builder (24 hours) |
| `/edit/ab12cd34` | your saved demo, editable |
| `/share/ab12cd34` | the read-only playground for a demo |
| `/d/ab12cd34/` | the built client page |
| `/embed/ab12cd34/` | the docs embed |
| `/?mode=full` | the preview alone, no editor chrome |
| `/my-demos`, `/all-demos` | your demos; everyone's |
| `/settings`, `/guide` | your profile; this page |

## 11. Settings and admin

- **Settings** is your display name, a short bio and your avatar — what shows on
  your demo cards.
- **Admin** (internal) is the usage and cost panel: how much the live containers
  and the AI features are costing, and the spend thresholds that throttle them. If
  a live preview refuses to start with a budget message, that is where the limits
  live.

## 12. When something looks wrong

**The preview sits on "Starting the live dev server…" for a while.** Expected on
Angular, Next, Nuxt, Astro and Remix: a real dev server is starting in a
container, and the first load installs the dependencies. The line under the
message is the live log, and **Details** shows the tail if you want to watch it.
A minute is normal. Much longer usually means the containers are all busy —
leaving the tab and coming back is the fix.

**"Live editing is paused until the monthly budget resets…"** The live containers
and the AI features cost money per use, so they stop when the month's ceiling is
reached rather than running up a bill. Saved demos, client links and embeds are
unaffected — they are static builds, and saving or forking still works. The
in-browser examples (the blank templates, JavaScript, TypeScript, React, Vue)
keep working too. What pauses is everything that runs in a container: Angular,
Next, Nuxt, Astro and Remix, and also the UI-library starters — MUI, Ant Design,
Fluent UI, Base Web — which look instant but are running a real dev server.

**"This example is unavailable for Handsontable *x.y.z*."** The example does not
exist for the version you picked — documentation examples come from that
version's own documentation, and a starter can require a newer core than the one
selected. Pick another version, or open a different example at this one. The same
applies to *"No documentation examples are available for…"*, which means the
whole set is missing for that version rather than the one you opened.

**The preview goes blank after an edit.** Look at the message under the preview
first: a compile error is reported there. If there is no error, the demo has
thrown at runtime — your browser's console (inside the preview frame) has it.

**A shared link says the demo has been revoked.** Someone deleted it. That is
permanent and cannot be undone; the demo has to be rebuilt and shared again, with
a new link.

**An embed is blank on a page.** Check the page it is on: embeds only render on
`handsontable.com`. If the URL in the `iframe` is a client link (`/d/…`) rather
than an embed link (`/embed/…`), that will be blank everywhere — client links are
deliberately not framable.

## Good to know

- Editing is internal-only. Client links are view-only and safe to share.
- A shared page never runs a server for the client — it is a fast static build.
- Unsaved edits live only in your browser tab. The **Download** button lights up
  when you have changes that nothing is persisting, because a refresh loses them.
- The AI features and the live containers cost real money per use, which is why
  they are metered and why the spend panel exists.
