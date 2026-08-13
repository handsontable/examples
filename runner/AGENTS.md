# AGENTS.md — Handsontable demo runner

Self-hosted live-demo system for Handsontable. Renders every example live at any
Handsontable version, lets the internal team edit code in the browser, and mints
permanent shareable/embeddable links. Also serves every documentation-guide
example (opened via `?docs=` URLs — see `docs/docs-examples.md`). Replaces
CodeSandbox/StackBlitz and the former `render-ms` microservice (removed). Lives in
the `runner/` folder of `handsontable/examples`.

Production: **https://demos.handsontable.com**, on the main Handsontable Cloudflare
account (not the sandbox). `wrangler whoami` tells you which account you are pointed at.

## Get the code

```bash
git clone git@github.com:handsontable/examples.git
cd examples/runner
pnpm install          # pnpm monorepo; Node 20+
```

Work happens on a feature branch off `master`, opened as a PR against `handsontable/examples`.
Cursor **Bugbot** auto-reviews each PR push.

## Layout

| Path | What it is |
|------|------------|
| `apps/authoring/` | The web app (Vite + React 19). SPA served as Cloudflare Workers Assets → worker `handsontable-demos-authoring`. |
| `packages/editor-shell/` | Framework-agnostic editor UI: toolbar, file tree, code editor, preview pane, theme. **Most UI/UX lives here.** |
| `packages/runtime/` | The `DemoRuntime` engines: `sandpack.ts` (Tier-1, in-browser bundler) and `container.ts` (Tier-2, live Cloudflare Sandbox container). Plus `version.ts` (HOT version dispatch). |
| `workers/api/` | Orchestration + sharing worker `handsontable-demos-api` (sessions, `/api/demos`, `/d`, `/embed`, build snapshotter, `/api/chat`). |
| `config/frameworks.json` | Single source of truth per example (tier, engine, wrappers, entry). `pipeline/import.mjs` → starter buckets + the `catalog.json` index. Key order is picker order. `synthetic: true` = no `examples/` directory; `pipeline/blank-starters.mjs` generates the files per bucket (the **blank** templates, ADR-0030). |
| `apps/authoring/public/docs-examples/` | Generated documentation-guide examples (manifest + one CatalogEntry JSON each). `pipeline/import-docs.mjs` + `wrap-docs-example.mjs`. |
| `apps/authoring/public/starter-examples/` | Generated starter buckets, one per Handsontable major plus `next` (DEV-2213), each pinned to a concrete version. `pipeline/import.mjs`; `catalog.json` is only the files-free index. |
| `containers/`, `scripts/` | Live/builder Dockerfiles + baked deps; `prepare-container.mjs`, `warm.ts`. |
| `docs/` | Architecture, ADRs, run/deploy notes. |

## URL model (routing lives in `apps/authoring/src/App.tsx`)

- `/` — public playground (pick an example, edit, live preview). Logged-in users see **Fork**.
- `/edit/:id` — **login-gated** editor bound to a saved demo: edit title/description/**code** + **Save** (rebuilds the snapshot) + **Share**.
- `/share/:id` — **public, read-only-persistence** playground: browse/edit files on the fly + **Download** (.zip of current edits), but **no Save and version is locked**.
- `/d/:id` — the built static demo (served from R2, framed by `/share`).
- `/embed/:id` — docs-only embed, frame-locked to `handsontable.com`.
- `/admin` — **login-gated** internal usage + cost panel (`docs/cost-guardrails.md`).

## Where to make UI/UX changes

Most visual work is in **`packages/editor-shell/src/`**:
- `theme.ts` — colors/spacing/fonts. Brand accent is Handsontable blue `#1A42E8`.
- `Toolbar.tsx`, `FileTree.tsx`, `EditorShell.tsx`, `CodeEditor.tsx`, `PreviewPane.tsx`, `styles.ts`, `logo.svg`.

App-level chrome (top bars, share/edit modes, dialogs) is in **`apps/authoring/src/`**:
`App.tsx`, `MyDemos.tsx`, `ShareLinks.tsx`.

The editor shell is consumed as TypeScript source by the app (Vite compiles it) — no separate
build step. Edit shell files and the app picks them up on hot-reload.

## Run locally

Two processes. **API worker** (Tier-2 live containers need Docker running):

```bash
cd workers/api
# .dev.vars (gitignored) holds the local login stand-in — see src/auth.ts.
npx wrangler dev            # http://localhost:8787
```

**Authoring app**:

```bash
cd apps/authoring
# .env.local (gitignored):  VITE_API_BASE=http://localhost:5173   # this dev server, not :8787
#                           VITE_DEV_USER=you@handsontable.com   # bypasses broker login locally
pnpm --filter @handsontable/demo-authoring dev   # http://localhost:5173
```

Two traps in that setup:

- **`?mode=full` needs the SPA and the worker on one origin.** `serveDemoAsset` sends
  `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` for `/d/:id` and is not wrapped in
  `cors()`. Production is same-origin so it works there; point `VITE_API_BASE` straight at `:8787`
  and the iframe is refused ("localhost refused to connect") *and* the status probe fails CORS,
  which renders as `● error` on a demo that is fine. `vite.config.ts` proxies `/api`, `/d` and
  `/embed` to the worker for exactly this reason — keep `VITE_API_BASE` on the dev server's own
  origin. An **empty** value does not work: `App.tsx` falls back to `:8787` on any falsy value.
- **`VITE_DEV_USER` short-circuits `currentUser()` before the fetch.** Any test of the real broker
  path has to override it (`VITE_DEV_USER= pnpm dev`) or it silently exercises the bypass instead.

## Verify before pushing

```bash
pnpm --filter @handsontable/demo-runtime build
pnpm --filter @handsontable/demo-editor-shell typecheck
pnpm --filter @handsontable/demo-authoring typecheck
( cd workers/api && npx wrangler deploy --dry-run )   # typechecks the worker + builds the image
```

The `demo-runtime build` is first on purpose: `apps/authoring` typechecks against
`packages/runtime/dist`, not its source, so a stale `dist` fails on symbols the source has.

What a green E2E run does and does not prove:

- **The specs that actually mount Sandpack are gated behind `E2E_LIVE=1`.** A default
  `playwright test` skips every one, so a green default run proves nothing about preview
  mount/teardown.
- **A persistence bug is invisible to a within-page test.** It only shows up in a spec that reloads
  and re-measures. Watch for an `addInitScript` that clears the storage key — it runs on
  `page.reload()` too, silently defeating the assertion it was meant to isolate. Each test already
  gets a fresh context, so no reset is needed.
- **Interaction states need a real pointer and `getComputedStyle`** — see
  [ADR-0026](docs/adr/0026-shell-styling-inline-vs-stylesheet.md). A synthetic `mouseover` does not
  fire CSS `:hover`, and a screenshot cannot tell a subtle live hover from a dead one.

## Build & deploy

Merging to `master` deploys automatically (see "CI/CD" below). To deploy by hand from
each dir:

```bash
# API worker
cd workers/api && npx wrangler deploy

# Authoring app
cd apps/authoring && pnpm --filter @handsontable/demo-authoring build && npx wrangler deploy
```

⚠️ **Prod build config.** The app reads `VITE_API_BASE` at build time:
- `apps/authoring/.env.production` (**committed**, no secrets) → `VITE_API_BASE=https://demos.handsontable.com`.
- `apps/authoring/.env.local` (**gitignored**) holds the dev bypass (`VITE_DEV_USER`) + local API base.

**Always build prod with `.env.local` absent** or the dev-login bypass leaks into the bundle.
After building, sanity-check:

```bash
grep -rl "localhost:8787\|VITE_DEV_USER\|dev@handsontable.com" apps/authoring/dist && echo BAD || echo OK
```

`VITE_API_BASE` itself is not the risk — `.env.production` is mode-specific, so it outranks
`.env.local` and the base compiles to `demos.handsontable.com` either way. `dev@handsontable.com`
is what catches a leaked `.env.local`; `localhost:8787` catches a missing `.env.production`
(the `|| "http://localhost:8787"` fallback in `App.tsx` surviving into the bundle). Don't widen
that term to a bare `localhost:` — catalog README text mentions dev-server ports and it false-fires.

## CI/CD

Seven workflows live in `.github/workflows/` at the repo root:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | every PR + push to `master` | build, typecheck, unit + catalog-smoke tests, authoring build, Playwright e2e. Also `workflow_call`able, so the deploy workflows gate on it. |
| `deploy-runner-api.yml` | push to `master` touching `workers/api`, `containers`, `scripts`, `config`, `packages` (or manual) | deploys `workers/api`. |
| `deploy-runner-authoring.yml` | push to `master` touching `apps/authoring`, `packages`, `config`, **`catalog.json`** (or manual) | builds + deploys `apps/authoring`. |
| `e2e-live.yml` | manual | the `E2E_LIVE=1` specs that mount a real preview. |
| `e2e-starter-matrix.yml` | manual | every starter through a live session; serialized against the global container cap. |
| `import-docs.yml` | manual, or `repository_dispatch: docs-examples-sync` from the docs repo | re-imports the documentation-guide examples. |
| `import-starters.yml` | manual, `repository_dispatch: starter-examples-sync`, weekly cron, or push touching `examples/**` | re-imports the versioned starter buckets (each from `prod-examples/<major>` when the branch exists, else `master`), rebuilds the catalog index + container contexts, opens a PR. |

The two deploy workflows authenticate with a repository secret (`CLOUDFLARE_API_TOKEN`);
no credential is committed. CI reads the pnpm version from `runner/package.json` so it
does not pick up the repo-root manifest.

## Conventions / guardrails

- **No secrets in git.** Auth is the Handsontable Google login broker (per-user token, sessionStorage). Dev bypasses live only in gitignored `.env.local` / `.dev.vars`.
- Use **wrangler against the main CF account** for any Cloudflare resource (D1 `DB`, KV `CACHE`, R2 `ARTIFACTS`).
- Keep the CodeSandbox **hosted** Sandpack bundler (self-hosting it stack-overflows on HOT v18).
- **Blank starters** (DEV-2499, ADR-0030): `blank` / `blank-ts` / `blank-react` are generated by
  `pipeline/blank-starters.mjs`, one variant per bucket — pre-17 buckets import the stylesheets and
  use the string `themeName`, 17+/next use `theme: mainTheme`. After editing a template run
  `node pipeline/import.mjs --synthetic` (regenerates only these, in every bucket) and
  `node scripts/prepare-container.mjs --generated-only` (refreshes `BUILD_CONFIG` without touching
  the committed baked contexts). Keep them minimal — `pipeline/blank-starters.test.mjs` fails on a
  file or plugin creeping in.
- **FILES drag & drop** (DEV-2500, ADR-0031) is **text-only** — a workspace is `Record<string,
  string>` end to end, so a dropped image has nowhere to live. Refusals are reported, never silent;
  `.env*` is never accepted. The traversal lives in `packages/editor-shell/src/dropFiles.ts` (no
  React, no DOM types) so `pipeline/drop-files.test.mjs` can drive it with fakes — a scripted
  `DataTransfer` returns `null` from `webkitGetAsEntry()`, so the e2e spec only reaches the
  plain-`files` fallback.
- **Imports are Handsontable-only** (DEV-2504, ADR-0032). `POST /api/import` pulls a workspace out
  of a JSFiddle or StackBlitz URL by parsing the page each one serves — undocumented payloads, so
  `pipeline/import-url.test.mjs` pins both against fixtures recorded from real projects; when a
  provider changes its page **that test is what fails**. `resolveSource` is the SSRF gate (exact
  hosts, https, rebuilt URL); `assertHandsontableProject` is the product gate and belongs on every
  future whole-project entry point. CodeSandbox is refused on purpose: its API answers 403 behind a
  bot challenge, and we do not work around that.
  An import is a **conversion, not a copy** (DEV-2509): CDN `<script>` tags become npm dependencies
  imported under the global's own identifier, and Handsontable's CDN CSS becomes an npm import so
  the demo follows the version picker. Copying verbatim produced demos that could not run.
- Tier-2 containers stay warm while a tab is open (client keepalive + `sleepAfter=5m`); disk is ephemeral, so a slept container cold-boots on return.
- **Cost guardrails** (DEV-2030, ADR-0022): `max_instances` 5/3 is the container cap — don't raise it without redoing the arithmetic in `docs/cost-guardrails.md`. Spend degrades live sessions in stages while static shares keep serving. The dollar thresholds and the enforcement switch are **editable at runtime in `/admin`** (stored in `runner_settings`); the `BUDGET_*` vars are only defaults.
- **Ask AI** (DEV-2047, `docs/example-chat.md`): chat panel scoped to the open example; docs chunks are retrieved **in the browser** (Cloudflare blocks Worker→workers.dev, error 1042), the Worker adds Algolia page links and calls LiteLLM. Model edits are proposed, never auto-applied, and every answer is metered into the cost ledger.
- **Style panel** (DEV-2047, `docs/style-panel.md`): Theme Builder's controls applied to the open example via Handsontable's **JS theme API** (`registerTheme`/`params`), written into the demo as a real module and wired into the grid; `POST /api/theme` does natural-language styling.
- **Analytics are anonymous by construction** — no cookies, no IPs, no user agents, no query strings, no per-request rows; unique visitors use a daily-rotating salted hash. Keep it that way when touching `workers/api/src/analytics.ts`.
- **No manual Handsontable CSS imports in `examples/` on master** (DEV-2200). Master feeds the 17+/next buckets, where core CSS auto-injects (since 17.0.0) and theming uses the JS theme object (`theme: mainTheme` from `handsontable/themes`, also 17.0.0+) — never the string `themeName`, whose stylesheet nothing injects. The `prod-examples/15|16` branches are the exception: below 17 there is no auto-injection and no `handsontable/themes`, so their sources keep `handsontable/styles/*.css` imports + string `themeName` — do not "clean up" CSS imports on those branches.
