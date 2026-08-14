# Ask Claude for a demo

**Who this is for:** anyone on the team. There is nothing to install, no folder to
prepare, no code to read and no browser step. If you can describe the grid you want
in a sentence, you can have a link to it — and the link is the same permanent client
link everybody else's demos get.

This runs through the **Handsontable MCP**, which every Claude session on your
`@handsontable.com` account already has. Claude writes the example, sends it to
demos.handsontable.com, and the runner builds it exactly as pressing **Save** in the
browser would.

## Ask for it

In Claude — the desktop app, the web app, Claude Code, anywhere the Handsontable MCP
is connected — describe the demo and ask for the link:

```
create a demo showing a sales grid with column filters, a total row
and Polish number formatting, and share the link with me
```

That is the whole interaction. A few more, for the shape of it:

```
make me a demo of a 50,000-row grid that stays smooth while scrolling,
for the enterprise evaluation call tomorrow
```

```
create a demo with two frozen columns and a right-click menu, in React,
on Handsontable 17.1.0
```

```
build a demo showing cell validation: an email column that goes red when
the address is malformed, with a description explaining what to try
```

## What comes back

Claude answers with the links, and the demo appears in **My demos** under your own
name:

| Link | What to do with it |
| --- | --- |
| `/d/<id>/` | **send this to the client.** A permanent page of the demo alone. |
| `/share/<id>` | send this to someone who wants to read the code. |
| `/embed/<id>/` | for embedding in the documentation (DevRel's job, mostly). |
| `/edit/<id>` | your own way back in, to change anything by hand. |

It is an ordinary demo of yours from that moment on: rename it, fork it, share it,
delete it, exactly like one you built in the browser.

## Saying what you want

Plain language is enough. What actually changes the result:

- **The grid itself** — columns, the kind of data in them, which features are on
  (sorting, filters, a context menu, merged cells, formulas, validation, a total
  row). Describe the customer's situation and let Claude choose the options.
- **The framework.** Say nothing and you get plain JavaScript, which is the fastest
  to build. Say "in React" or "in Vue" and you get that; Angular, Next.js, Nuxt,
  Astro and Remix work too, they just take longer to come back because they build in
  a real container.
- **The Handsontable version.** Say nothing and you get the current release. Name a
  version — "on 17.1.0" — if the conversation is about that one.
- **The description.** Claude writes one, because whoever opens the link later was
  not in your conversation. Tell it what to say if the demo is going into a ticket or
  a customer thread — a link back to that thread is usually the useful part.

## Before you send the link

Two things, and they matter more on this route than any other, because there is no
moment where you look at the files:

- **Open the client link yourself first.** It takes five seconds and it is the only
  way you know the demo built and shows what you asked for.
- **Never ask for a demo built from a customer's real data.** If you paste a
  spreadsheet into the conversation, that data ends up on a public page. Ask for
  *realistic invented* data instead — "invoice-looking rows, made up" — and say so in
  the description.

## What it will not do

- **It is for examples, not projects.** Up to 50 text files and 256 KB of source.
  Anything called `.env` is refused, as are `node_modules`, build output and
  lockfiles — refused, not silently dropped, so you find out rather than wondering.
- **It creates demos as you, and only as you.** The MCP knows your Google identity
  from your session; it cannot publish under someone else's name, and only
  `@handsontable.com` accounts can create anything here at all.
- **It cannot edit the site itself**, change someone else's demo, or delete anything.

## If it says the tool is not configured

This route shipped on **14 August 2026**. If Claude answers that demo creation is not
configured, or does not seem to know the tool exists, your session predates the
rollout: start a new conversation, or reconnect the Handsontable MCP, and ask again.
If it still refuses, the runner side is unreachable — say so in the team channel
rather than working around it, and use the browser route in the meantime.

## Where your demos live

**My demos** in the account menu lists everything you have created, whichever way you
made it — open it, copy the link, rename it, fork it, delete it. **All demos** shows
the whole team's, so you can check whether the demo you are about to ask for already
exists. Somebody else's demo is read-only for you, but **Fork** gives you your own
copy to change.
