# ADR-0036: The API owns the Handsontable version (derive, don't default)

**Status:** Accepted

## Context
ADR-0005 defines what a Handsontable version *is*: semver (including npm
partials), a bare pkg.pr.new id, or a `pkg.pr.new` URL, applied by
`applyHandsontableVersion`. What it never said is *who* applies it.

In practice only the browser did. `pinHandsontableFiles` lived in
`apps/authoring/src/App.tsx`, and the API treated the version as free-form
metadata: both create routes stored `body.htVersion ?? "latest"` without
validating it, `share.ts` documented its input as `files // already
version-injected`, and `grep validateHandsontableVersion workers/api/src/`
returned nothing. The submitted `package.json` installed exactly as written.

That split broke as soon as a caller other than the editor appeared. A demo
created over the MCP (ADR-0033) without an explicit `ht_version` landed with
`ht_version = "latest"` — a string `validateHandsontableVersion` rejects — and
every downstream consumer treats that column as a validated ref:

- the editor adopts it as version state and suppresses its own latest-fallback
  (`hadUrlVersion`), so `/edit/:id` renders the boot refusal
  `handsontable-version must be semver-valid or a pkg.pr.new id/URL`
- `pinHandsontableFiles` returns the file map unchanged for an invalid version,
  so nothing normalises the dependency any more
- a hand-typed `"handsontable": "13106"` therefore reached pnpm as a registry
  range: `ERR_PNPM_NO_MATCHING_VERSION ... handsontable@13106` (Sentry DEMOS-1X,
  DEV-2565). The save failed, so the edits were never persisted.

Every MCP-created demo that omitted `ht_version` was unopenable in `/edit`.

## Decision
The API resolves the version and pins the files. Four handlers — `POST
/api/mcp/demos`, `POST /api/demos`, and both rebuild PATCHes — call
`resolveHandsontableVersion` (`workers/api/src/ht-version.ts`) before the budget
gate, and pass its `files` and `ref` to `createDemo` / `updateDemo`.

Resolution order is **derive, don't default**:

1. a concrete ref the caller explicitly asked for — validated, and an unusable
   one is a `400` carrying the validator's own message
2. the ref the submitted `package.json` already pins
   (`handsontableDependencyRef`)
3. a dist-tag (`latest`, `next`) the caller asked for, resolved through the same
   catalog `GET /api/versions` serves — never stored as the tag itself
4. the demo's current `ht_version`, on a rebuild — a candidate, never an
   authority, because legacy rows hold the sentinel
5. npm `latest`

Step 2 is the load-bearing one. A caller that pins a pkg.pr.new build in
`package.json` and says nothing about `htVersion` is asking for *that* build.
Resolving the missing version against npm and rewriting the dependency would
rebuild its demo against a different core — worse than the bug being fixed, and
exactly the case DEV-2565 came from. So the payload is asked before npm.

A dist-tag deliberately ranks *below* the payload (step 3, not step 1): it names
whatever npm has today, which is the same non-answer a range is. `MyDemos`'s fork
forwards the row's `ht_version` verbatim, so a demo saved before this ADR forks
with `htVersion: "latest"` while its `package.json` pins a PR build — treating
the tag as authoritative there would move the fork onto a different core. A
*concrete* explicit ref does outrank the payload, which is the contract the
editor and hot-mcp both rely on: **explicit beats the payload's pin; omitting it
preserves the pin.**

`pinHandsontableFiles` moves into `packages/runtime/src/version.ts` so the editor
and the worker share one rewrite rule. It stays `dependencies`-only and keeps the
`@handsontable/pikaday` exemption (ADR-0005), and it is idempotent — the rewrite
never reads the incoming dependency value, so an already-pinned map is a fixed
point. That matters because hot-mcp pre-pins on its side.

Demos saved before this ADR are repaired where both halves are in hand rather
than by a batch job: `GET /api/demos/:id/source` returns `htVersion` from
`editorVersionRef(row.ht_version, files)` — the column when the validator accepts
it, else the snapshot's own pin — and the editor prefers it over
`meta.ht_version`. The next Save then stores the derived ref.

## Consequences
- An invalid version costs a `400`, not a builder container.
- **Behaviour change:** the editor always sends `htVersion`, so a hand-edited
  Handsontable dependency in `package.json` no longer survives Save — the picker
  wins and the dependency is rewritten to its ref. On master that edit survived
  (the API installed the file map verbatim), which is why the demo behind
  DEV-2565 built against its PR core at all. The pin has to move with the picker
  for preview, artifact and column to agree, and the picker accepts a pkg.pr.new
  ref or URL, so the hand edit is no longer the way to ask for a PR build.
- No batch backfill: rows created before this ADR keep the sentinel in
  `ht_version` until something saves them. Only the editor was broken by it —
  `demos-list` shows the column as a label and `buildCacheKey` only needs it to
  be stable — so lazy repair through the source route is enough, and it avoids
  guessing a ref for a demo nobody opens.
- `demos.ht_version` always holds a ref the editor can validate, so it stays
  usable as both label and `buildCacheKey` component.
- Server-side pinning also covers the saved-demo edit path, where the client
  re-pins nothing: the starter effect returns early for a saved demo
  (`App.tsx:1554`) and the ad-hoc re-pin effect is gated on an import phase a
  saved demo never enters (`:1700`), so `onSave` / `onEmbed` / `onFork` ship the
  files as loaded. Preview, artifact and column now agree.
- A rebuild whose `package.json` no longer matches its lockfile installs through
  the existing `--no-frozen-lockfile` retry (`share.ts`), which is what has
  always absorbed an editor re-pin.
- `POST /api/session` (Tier-2 live previews) is untouched: it is ephemeral, the
  client pins before posting, and it stores nothing. It does drop the `pkgPrNew`
  flag on the wire (`container.ts` sends `version.ref` only), so if a server-side
  pin is ever wanted there, the ref has to be re-validated the way this module
  does.
