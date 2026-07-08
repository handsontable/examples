# How to create and share a demo

A short, non-technical guide for the Handsontable team.

## 1. Open the authoring app

Go to **https://handsontable-demos-authoring.handsoncode.workers.dev**. Browsing
and editing are **open** — no sign-in needed to play with examples. You only
**Sign in with Handsontable** (top-right, `@handsontable.com` only) when you want
to **create a shareable client link** or see **My demos**.

## 2. Pick a starting point

Use the **Example** dropdown (top-left) to choose a framework — React, Vue,
Angular, Next.js, Astro, Nuxt, Remix, and more. The demo appears live on the
right. This is your starting template (a "fork").

You can also open one of your saved demos from **My demos** and fork it.

## 3. Choose a Handsontable version

Use the **Handsontable** version dropdown (real published versions) to render the
demo at any version. Need a specific build (e.g. a nightly like
`0.0.0-next-07941cf-20260708` or a `pkg.pr.new` preview)? Type it into the
**custom version** box next to the dropdown and press Enter.

## 4. Edit the code

Click any file on the left and edit in the middle panel. The preview updates
live as you type — instantly for most frameworks, within a couple of seconds for
the server-based ones (Next, Nuxt, Astro, Remix, Angular).

## 5. Share it

Click **Share**. Give it a **title** and an optional **description**, then
**Create link**. You'll get:

- a **Client link** (e.g. `…/d/ab12cd34/`) — send this to a client. It's a
  permanent, static page; it keeps working and costs nothing to keep online.
- a **Docs embed URL** (`…/embed/ab12cd34/`) — for embedding the demo on a
  Handsontable docs page. It only works when embedded on `handsontable.com`.

Use the **Copy** buttons. Done!

## 6. Manage your demos

Open **My demos** to see everything you've created, open a demo's client link, or
fork it into a new one. (To revoke a link so it stops working, ask a developer —
revoked links show a "revoked" message.)

## Notes

- Editing is internal-only. Client links are view-only and safe to share.
- Nothing you share runs a live server for the client — it's a fast static page.
