# Demos from a pull request, a nightly, or your own project

**Who this is for:** developers. The routes that need something the browser cannot give
you: an unreleased build, a project that lives on your machine, and the details of how
a demo is assembled when something does not work.

## Demo an unreleased fix: the PR number as the version

When the answer is "that is fixed, it just is not released yet", you can hand support
or the customer a demo running **the code from that pull request**. Every Handsontable
PR publishes a build to [pkg.pr.new](https://pkg.pr.new), and the version control takes
its number:

1. Open any demo — a starter, a documentation example, your own saved one.
2. Click the **pencil** next to *Handsontable 18.0.0* in the preview bar.
3. Type the **PR number** — `13191` — and press Enter.
4. The preview rebuilds against that PR; the pill reads `Handsontable 13191`.
5. **Fork** or **Save** and the demo keeps that build, so the link keeps it too.

Or skip the clicking:

```
https://demos.handsontable.com/?example=javascript&v=13191
https://demos.handsontable.com/?docs=guides/rows/rows-sorting/react/exampleSortingDemo.tsx&v=13191
https://demos.handsontable.com/?example=react&v=https://pkg.pr.new/handsontable@13191
```

![A demo running at a pull-request build: the version pill reads Handsontable 13191 and package.json points at pkg.pr.new](/guide/pr-version.jpg)

*Verified on PR #13191: the pill reads `13191`, `package.json` points at
`https://pkg.pr.new/handsontable@13191`, and the grid renders on that build.*

This is the reason support and engineering can look at the same URL: they send you a
reproduction on the released version, you send it back with the number of your PR in
the query string.

## What the runner does with that number

The version input accepts four things, and resolves them before the demo is built:

| You type | It becomes |
| --- | --- |
| `18.0.0`, or a partial `17.1` | that published version |
| `0.0.0-next-07941cf-20260708` | that nightly from the npm `next` builds |
| `13191` (any integer ≥ 1000) | `https://pkg.pr.new/handsontable@13191` |
| `https://pkg.pr.new/handsontable@<ref>` | that build, ref taken verbatim |

The rewrite covers **every** dependency whose package name contains `handsontable`
except `@handsontable/pikaday` — core and the framework wrapper together — so a React
or Vue demo gets the matching wrapper build rather than a mismatched pair. Supported
majors are **15–19**; anything outside that is refused rather than half-working.

Two edges worth knowing:

- **A bare integer is only a PR ref from 1000 up.** `15`–`19` are read as majors —
  `18` means 18.0.0 — and `20`–`999` are refused outright rather than guessed at.
  Real Handsontable PR numbers are five digits, so this only bites on toy input.
- **The build has to exist.** If CI has not published yet, or the PR comes from a fork
  that cannot publish, the install fails and the preview says so. `curl -sI
  https://pkg.pr.new/handsontable@<number>` answering `200` is the check.

## Where a demo runs, and why some are slow

Two engines, and which one you get is decided by the starter:

- **In-browser** — the blank templates, JavaScript, TypeScript, React, Vue.
  Bundled in the page by Sandpack. Fast, cheap, no container, and unaffected by the
  monthly budget.
- **Container** — Angular, Next.js, Nuxt, Astro, Remix, and the UI-library
  starters (MUI, Ant Design, Fluent UI, Base Web). A real dev server in a Cloudflare
  Sandbox, with a real `install`. The first load is slow by construction, and these are
  what the budget ceiling pauses. One surprise in the list: React (Vite, JS) runs in a
  container too, despite being a React starter — the instant React is the TypeScript
  one.

If you are demonstrating grid behaviour rather than framework integration, pick an
in-browser starter: it costs nothing, starts instantly, and a PR build resolves in it
just as well.

## Publish an example from your own machine

If the example already exists in a folder, the **publish-demo** Claude Code plugin does
the mechanical half: it works out which starter matches the project and which
Handsontable version it pins, stages a clean copy of the files (no `node_modules`,
build output, lockfiles, binaries or anything called `.env`), opens the runner with the
starter and version already selected, writes the title and description, and afterwards
checks that the demo built.

Install it once:

```
claude plugin marketplace add handsontable/claude-plugins
claude plugin install publish-demo@handsontable
```

Then, in the folder with your example:

```
publish this demo
```

It is **not** a one-command upload: signing in here is a Google login in the browser,
so the drag step is real — the plugin removes everything around it, not the login
itself. There is a sibling plugin, **publish-app**, for the other job: an application
with a backend, a login or its own storage gets its own Cloudflare Worker and belongs
there.

For a demo that does not exist yet, the **Handsontable MCP** route is faster than either
— describe it in Claude and get the built link back, with no browser step at all:

```
Load create_demo, then create a demo reproducing the autocomplete
dropdown width issue on Handsontable 18.0.0, and give me the share link
```

```
Load update_demo, then re-point demo 1g72n1o3r2 at pull request 13191
so support can see the fix
```

Name the tool first (`Load create_demo` / `Load update_demo`): tools are fetched on
demand, and a long session will not always reach for one unasked. `update_demo` edits the
demo in place — same id, same links, so a reproduction you have already sent to support
becomes the fixed version rather than a second link to explain. Full instructions are on
the [Everyone track](/guide/everyone); it applies to you too.

## What the runner accepts

The same rules on every path — file drop, plugin, MCP — with the per-path differences
called out:

- **Text files only.** Source (`.js .jsx .mjs .cjs .ts .tsx .vue .svelte .astro`),
  markup and styles (`.html .css .scss .sass .less .svg`), data and config
  (`.json .yaml .yml .toml .csv .md`), and `package.json`.
- **No binaries** — with one exception: a **`.zip`** dropped on FILES is unpacked in the
  browser rather than stored, and its entries then face every rule in this list. A
  single wrapping directory is stripped, `..` paths are refused outright, and the
  unpacked total is capped so an archive cannot fill the tab. Everything else binary
  stays refused: a demo's files are text all the way to the build, so reference a
  hosted URL or inline a data URI.
- **`.env` and `.env.*` are never accepted**, on any path, and that is deliberate rather
  than incidental.
- **`node_modules`, build output and lockfiles never make it in**, but the two paths
  say so differently. The MCP refuses the whole payload, with the reason. A file drop
  skips them quietly — nobody means to drop `node_modules` — and stops at 50 files,
  saying where it stopped.
- **About 50 files and 256 KB of source** on the MCP path. If an example is bigger than
  that, it is a project: trim it to the grid, its data and its configuration.

Dependencies come from `package.json`, resolved at build time, so adding a library is an
edit to that file — there is no install step you can run in the workspace.

## Reading a demo out again

**Download** (top bar, or the Files header) gives you the whole workspace as a `.zip`,
including your unsaved edits, with the version pinned in `package.json`. That is the
bridge back to a local reproduction: unzip, install, run.

`/share/<id>` is the same thing for someone else — full code, no save.

## When a build fails

- **The client link answers 404.** The build failed. Open `/edit/<id>`, press **Save**
  and read the error; the message is the bundler's, not ours.
- **The preview errors immediately after a version switch.** The code uses an API that
  version does not have. That is a real answer to a compatibility question, not a
  broken demo.
- **A PR build fails to install.** See above: the build is probably not published yet.
- **"Live editing is paused…"** is the monthly budget on the container starters.
  In-browser starters keep working, and existing links and embeds are unaffected —
  they are static builds. A Save or a Fork boots a build container, though, so the
  top budget tiers refuse those too.
- **An import was refused as not-Handsontable.** The guard wants a `handsontable`
  dependency, an import of it, or a CDN tag. A project that uses it only through your
  own wrapper package will trip this; add the dependency, or drop the files in instead.
