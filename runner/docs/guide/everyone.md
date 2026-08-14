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

### If Claude does not seem to have the tool

Ask for it by name — **"load create_demo"** — and then ask again. Claude loads tools on
demand, and a long conversation may not have reached for this one yet.

## A real one, start to finish

This is an actual run, not an illustration. The prompt:

```
Load create_demo, then create a Handsontable demo with an invoice grid
(12 rows, column filters, status dropdown, totals row) and give me the
share link.
```

![The Claude conversation: the prompt, then Claude loading the tool, checking the documentation, writing the files and publishing to the runner](/guide/claude-asking.jpg)

*The whole interaction, as it looks in Claude. The grey lines are Claude narrating what it
is doing; you do not have to read them.*

What Claude did, in its own words: checked the Handsontable documentation, wrote the files
locally and syntax-checked them, published through `create_demo`, and — when the runner
refused the first attempt because the `package.json` it wrote had dropped the build tool —
fixed that and published again. One demo, not two: a refused publish creates nothing.

**The first time, Claude asks permission** to use the tool — "Claude wants to use *Create
a Handsontable demo* from Handsontable MCP". Choose **Allow once**, or **Always allow** if
you expect to do this again.

![Claude's answer: the client link, the edit link, the read-only playground and the docs embed URL](/guide/claude-links.jpg)

*And the answer: four links, and the demo waiting in your My demos.*

Then it handed back the four links, and a summary of what it had built: twelve invoices
with generated client names, a filter menu on every header, a strict Draft / Sent / Paid
/ Overdue dropdown, and a pinned totals row that recalculates to whatever the filter
leaves visible.

Which is the point of this route: two lines of typing, and a link with a real answer in
it.

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

## Open the link before you send it

**Always. Every time.** This matters more here than on any other route, because there is
no moment where you look at the demo yourself, and because of one thing worth
understanding:

**A demo that builds is not the same as a demo that works.** The runner compiles the
code and publishes the page; it does not click around in the result. Code that compiles
and then fails the moment the grid starts up still gets a green build and a working link.
That happened on the very run above: the page came out with its title, its description
and its buttons — and an empty space where the grid should be.

![The published demo: twelve invoices, colour-coded statuses and a pinned TOTAL row](/guide/mcp-demo-client-page.jpg)

*The client link from the run above — what a customer sees. The demo alone: no editor, no
sign-in.*

![The same demo filtered to two clients, with the totals row recomputed to four invoices](/guide/mcp-demo-filtered.jpg)

*Filtered to two clients, and the totals row follows the filter. Worth clicking around in
before you send it: that is how you find out whether Claude built what you meant.*

So open the client link and look for the grid:

- **Grid there, data plausible?** Send it.
- **Title and description, but a blank space where the grid should be?** The code failed
  at startup. Paste the link back to Claude, say the grid does not render, and ask it to
  fix and re-save. The link stays the same, so anything you already sent starts working
  once it is fixed.
- **"This demo is not available" or a 404?** The build failed. Ask Claude to try again.

Claude often **cannot open the link itself** — the sandbox it runs in is not allowed to
reach demos.handsontable.com. If it says it could not verify the demo, that is not
hedging: you are the only one who can check.

**And never ask for a demo built from a customer's real data.** If you paste a
spreadsheet into the conversation, that data ends up on a public page. Ask for
*realistic invented* data instead — "invoice-looking rows, made up" — and say so in the
description.

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
rather than working around it, and use the [browser route](/guide/support) in the
meantime.

## Changing a demo, also by asking

You do not have to start again to change one. Tell Claude what to fix or add — "make the
Overdue rows red", "add a VAT column", "the grid does not render, please fix it" — and it
updates **the demo you already have**, at the same links. Anything you have already sent
keeps working, and starts showing the new version.

**Status: landing shortly.** The endpoint behind it is in review
(`handsontable/examples` #177). Until it deploys, Claude can still write the change, and
you apply it one of two ways:

- Open **`/edit/<id>`**, paste in what Claude gives you, press **Save** — same link, same
  demo. Anyone technical can do this in a minute if you would rather not.
- Or ask Claude for a new demo and **delete the old one** in My demos — but only if you
  have not sent the first link to anybody. Deleting revokes it for good.

Once it is live, "make me one" and "change it" are the same conversation, and neither needs
the browser.

## Where your demos live

![My demos: a demo card with a rendered markdown description, beside the Create and Import tiles](/guide/my-demos.jpg)

*My demos, with the two tiles that start the commonest browser routes.*

**My demos** in the account menu lists everything you have created, whichever way you
made it — open it, copy the link, rename it, fork it, delete it. **All demos** shows
the whole team's, so you can check whether the demo you are about to ask for already
exists. Somebody else's demo is read-only for you, but **Fork** gives you your own
copy to change.
