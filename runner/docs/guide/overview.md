## What this site is

A live playground for Handsontable. Every example runs for real in the browser, you
can edit the code and watch it change, and you can turn any of it into a permanent
link to send to a client or embed in the documentation.

Browsing and editing are **open to anyone** — no sign-in. Signing in
(`@handsontable.com` only) is what adds saving, sharing and My demos. The
**Sign in** link sits at the bottom-right of the status bar, next to the version
readout; it is deliberately quiet, because most visitors here are not on the team.

Nothing on this site requires a checkout, an editor, or a build tool. One of the
four routes above requires no browser either.

## The links every demo has

A saved demo is reachable four ways, and picking the right one is most of what
"sharing a demo" means:

| Link | What it is | Send it to |
| --- | --- | --- |
| `/d/<id>/` | the **client link** — a permanent static page of the demo alone | a customer |
| `/share/<id>` | the **read-only playground** — the code, editable in place, not savable | someone who asked "how is it done?" |
| `/embed/<id>/` | the **docs embed** — renders only inside `handsontable.com` | an `iframe` in the docs or a blog post |
| `/edit/<id>` | the **editor** — yours to change, if you own it | nobody; it is your own bookmark |

## Useful URLs

Anything you can reach by clicking, you can also link to directly:

| URL | Opens |
|-----|-------|
| `/?example=blank` | a blank template (also `blank-ts`, `blank-react`) |
| `/?example=react` | a framework starter (`javascript`, `typescript`, `vue`, `angular`, `next.js`, `nuxt`, `astro`, `remix`, `mui`, `ant-design`, `fluent-ui`, `base-web`) |
| `/?docs=guides/columns/column-adding/react/example1.tsx` | a documentation example |
| `/?v=17.1.0` | the same page at a chosen version (combines with the above) |
| `/?v=13191` | the same page built from pull request 13191 |
| `/?import=<url>` | the import flow for a JSFiddle or StackBlitz URL |
| `/?payload=<id>` | a project handed over from the Theme Builder (24 hours) |
| `/?mode=full` | the preview alone, no editor chrome |
| `/edit/<id>` | your saved demo, editable |
| `/share/<id>` | the read-only playground for a demo |
| `/d/<id>/` | the built client page |
| `/embed/<id>/` | the docs embed |
| `/my-demos`, `/all-demos` | your demos; everyone's (`?owner=` filters) |
| `/settings`, `/guide` | your profile; this guide |

## Ground rules

The same four rules whichever route you take:

- **Never publish a real customer's data.** Demos are internal to create and public
  to read: anyone with a client link can open one, and the code is readable on
  `/share/<id>`. Regenerate the data first, and say in the description that you did.
- **Never a licence key, a token, or a `.env` file.** The runner refuses `.env*`
  outright, but that is a backstop, not your check.
- **Handsontable demos only.** Imports and file drops with no Handsontable in them
  are refused by design; this playground is not general hosting. An application with
  a backend, a login or its own storage belongs behind the `publish-app` flow instead.
- **Pin the version that matters.** A demo runs at one Handsontable version. If you
  are reproducing a bug, pin the version it was reported against — that is the whole
  point of the demo.

## When something looks wrong

**The preview sits on "Starting the live dev server…" for a while.** Expected on
Angular, Next, Nuxt, Astro and Remix: a real dev server is starting in a container,
and the first load installs the dependencies. The line under the message is the live
log, and **Details** shows the tail if you want to watch it. A minute is normal.
Much longer usually means the containers are all busy — leaving the tab and coming
back is the fix.

**"Live editing is paused until the monthly budget resets…"** The live containers and
the AI features cost money per use, so they stop when the month's ceiling is reached
rather than running up a bill. Saved demos, client links and embeds are unaffected —
they are static builds, and saving or forking still works. The in-browser examples
(the blank templates, JavaScript, TypeScript, React, Vue) keep working too. What
pauses is everything that runs in a container: Angular, Next, Nuxt, Astro and Remix,
and also the UI-library starters — MUI, Ant Design, Fluent UI, Base Web — which look
instant but are running a real dev server.

**"This example is unavailable for Handsontable *x.y.z*."** The example does not exist
for the version you picked. Documentation examples travel with their version:
switch the version back, or pick the modern equivalent.

**A client link answers 404.** The demo's build failed. Open `/edit/<id>`, press
**Save** again and read the error. A **410** means the demo was deleted — deleting
revokes the link, and it cannot be undone.

## Settings and admin

- **Settings** is your display name, a short bio and your avatar — what shows on your
  demo cards.
- **Admin** (internal) is the usage and cost panel: what the live containers and the
  AI features are costing, and the spend thresholds that throttle them. If a live
  preview refuses to start with a budget message, that is where the limits live.
