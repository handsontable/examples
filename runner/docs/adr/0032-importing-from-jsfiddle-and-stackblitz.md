# ADR-0032: Importing from JSFiddle and StackBlitz; the Handsontable-only rule

**Status:** Accepted (DEV-2504, subtask of DEV-2498)

> Numbered after ADR-0030 (blank starters, DEV-2499) and ADR-0031 (FILES drag &
> drop, DEV-2500), each on its own branch.

## Context

Demos live in three other playgrounds today. Getting one onto
demos.handsontable.com meant copying files by hand, so the ask was to paste a
URL instead — JSFiddle and StackBlitz first, CodeSandbox if possible.

None of the three offers a documented read API for this, so the first question
was what is actually fetchable. Probed against real projects (2026-08-12):

| Provider | Probe | Result |
|---|---|---|
| JSFiddle | `GET /1bw9tphk/1/` | ✅ all three panels server-rendered into `<textarea name="code_html\|code_css\|code_js">`, HTML-escaped (6,847 / 17,865 / 48,339 chars) |
| StackBlitz | `GET /edit/vitejs-vite-de8qy2bm` | ✅ the whole project in `<script type="application/json" data-redux-store="">` → `project.appFiles` (28 entries, contents inline) |
| StackBlitz | `GET /api/projects/<slug>` | ❌ metadata only — title, owner, `webcontainerBased: true`, **no files** |
| CodeSandbox | `GET /api/v1/sandboxes/nj3gp2` | ❌ **403**, Cloudflare bot challenge |
| CodeSandbox | `GET /p/devbox/nj3gp2` | ❌ 5.7 KB client-rendered shell, no files |

## Decision

**1. Two providers, parsed from the page they already serve.** JSFiddle's three
textareas and StackBlitz's Redux snapshot. Neither is a documented contract, so
both are pinned by fixture tests recorded from the real projects
(`pipeline/fixtures/`), and a shape change fails in CI rather than in front of a
user. When it does fail, the user sees a sentence naming the manual route — never
a stack trace.

**2. CodeSandbox is refused with instructions, not attempted.** Its API sits
behind a bot challenge; defeating that is not something we will do. A pasted
CodeSandbox URL returns "Export the sandbox to a .zip … and drag the files onto
the FILES panel" — the route that does work (ADR-0031).

**3. The fetch happens in the Worker, behind an exact-host allowlist.** Neither
origin sends CORS headers, and an endpoint that fetches a user-supplied URL is
SSRF surface. `resolveSource` is the single gate: https only, exact hosts (no
suffix match — `jsfiddle.net.evil.example` must not pass), and it **rebuilds** the
URL it fetches from the parsed slug rather than requesting the user's string. The
endpoint requires a signed-in user, caps the response at 8 MB (the StackBlitz page
is 2.5 MB), and times out at 15 s.

**4. Only Handsontable projects can be imported.** `assertHandsontableProject`
requires evidence in the *files*: a `handsontable` / `@handsontable/*` entry in
package.json, a module specifier or CSS import of either, a jsDelivr / unpkg /
cdnjs tag, or `new Handsontable(...)`. A fiddle has no manifest at all, so the
CDN and constructor forms are not a nicety — they are how the real example passes.
Matching is anchored, so `handsontable-clone` and prose mentioning the word do not
count.

This playground exists to show Handsontable. A project that does not use it would
be someone else's app consuming our build minutes and our share links. The check
lives in one exported function, called from `importFromUrl`, so the next entry
point that ingests a whole project (the MCP push, DEV-2501) reuses it rather than
re-deriving it.

**5. Text only, same rules as drag & drop** (ADR-0031): binaries, `.env*`,
lockfiles and `node_modules`/`dist` are dropped, per-file 512 KB, 80 files per
import. Everything dropped is reported back and rendered as a notice next to the
version warning — a silent loss is the failure mode worth avoiding.

**6. `?import=<url>` is the entry point, and the import is unsaved.** The dialog
in My demos only collects a URL and navigates; the playground performs the one
fetch off the param, then strips it from the URL so a reload does not re-import
over the author's edits. The workspace opens dirty and unsaved, exactly like a
fork — the author reviews before Save.

## Consequences

- The starter-load effect had to learn about imports: it re-runs on the
  `framework` an import just set, and would otherwise replace the imported files
  with a catalog snapshot. `importPhase` gates it.
- Verified end to end against the three URLs above: the fiddle imports as 4 files
  (`javascript`, title "Handsontable example"), the StackBlitz project as 24 of
  its 28 (`typescript`, title "ToolBar Demo" — `dist/` and `package-lock.json`
  correctly left behind), and the CodeSandbox URL returns the explanation.
- A StackBlitz project that is private, or a Bolt app, has no `appFiles` in its
  page; that is reported as such rather than as an empty import.
- `usage_daily` gains an `import` metric with the provider as its dimension, so
  /admin shows which provider people actually use — and whether CodeSandbox keeps
  being pasted, which is what would justify revisiting decision 2.
