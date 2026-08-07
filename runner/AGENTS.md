# AGENTS.md — Handsontable demo runner

Self-hosted live-demo system for Handsontable. Renders every example live at any
Handsontable version, lets the internal team edit code in the browser, and mints
permanent shareable/embeddable links. Also serves every documentation-guide
example (opened via `?docs=` URLs — see `docs/docs-examples.md`). Replaces
CodeSandbox/StackBlitz and the former `render-ms` microservice (removed). Lives in
the `runner/` folder of `handsontable/examples`.

Production: **https://demos.handsontable.com** (Cloudflare account `15111272c53ed0aaf84a908f0c9c7f8b`).

## Get the code

```bash
git clone git@github.com:handsontable/examples.git
cd examples/runner
pnpm install          # pnpm monorepo; Node 20+
```

Work happens on a feature branch off `master`, opened as a PR against `handsontable/examples`
(current WIP branch: `runner-live-demos`, PR #37). Cursor **Bugbot** auto-reviews each PR push.

## Layout

| Path | What it is |
|------|------------|
| `apps/authoring/` | The web app (Vite + React 19). SPA served as Cloudflare Workers Assets → worker `handsontable-demos-authoring`. |
| `packages/editor-shell/` | Framework-agnostic editor UI: toolbar, file tree, code editor, preview pane, theme. **Most UI/UX lives here.** |
| `packages/runtime/` | The `DemoRuntime` engines: `sandpack.ts` (Tier-1, in-browser bundler) and `container.ts` (Tier-2, live Cloudflare Sandbox container). Plus `version.ts` (HOT version dispatch). |
| `workers/api/` | Orchestration + sharing worker `handsontable-demos-api` (sessions, `/api/demos`, `/d`, `/embed`, build snapshotter, `/api/chat`). |
| `config/frameworks.json` | Single source of truth per example (tier, engine, wrappers, entry). `pipeline/import.mjs` → `catalog.json`. |
| `apps/authoring/public/docs-examples/` | Generated documentation-guide examples (manifest + one CatalogEntry JSON each). `pipeline/import-docs.mjs` + `wrap-docs-example.mjs`. |
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
# .dev.vars (gitignored):  DEV_AUTH_EMAIL=you@handsontable.com
npx wrangler dev            # http://localhost:8787
```

**Authoring app**:

```bash
cd apps/authoring
# .env.local (gitignored):  VITE_API_BASE=http://localhost:8787
#                           VITE_DEV_USER=you@handsontable.com   # bypasses broker login locally
pnpm --filter @handsontable/demo-authoring dev   # http://localhost:5173
```

## Verify before pushing

```bash
pnpm --filter @handsontable/demo-runtime build
pnpm --filter @handsontable/demo-editor-shell typecheck
pnpm --filter @handsontable/demo-authoring typecheck
( cd workers/api && npx wrangler deploy --dry-run )   # typechecks the worker + builds the image
```

## Build & deploy

Deploys are currently **manual** (no CI yet — see "CI/CD" below). Deploy from each dir:

```bash
# API worker
cd workers/api && npx wrangler deploy

# Authoring app
cd apps/authoring && pnpm --filter @handsontable/demo-authoring build && npx wrangler deploy
```

⚠️ **Prod build config.** The app reads `VITE_API_BASE` at build time:
- `apps/authoring/.env.production` (**committed**, no secrets) → `VITE_API_BASE=https://demos.handsontable.com`.
- `apps/authoring/.env.local` (**gitignored**) holds the dev bypass (`VITE_DEV_USER`) + local API base.

**Always build prod with `.env.local` absent** or the dev-login bypass and `localhost:8787` leak
into the bundle. After building, sanity-check:

```bash
grep -rl "localhost:8787\|VITE_DEV_USER\|dev@handsontable.com" apps/authoring/dist && echo BAD || echo OK
```

## CI/CD

There is no `.github/workflows` and **no GitHub Actions by design** (we don't want API tokens in
the repo). To get auto-deploy-on-merge + PR preview URLs, connect **Cloudflare Workers Builds**
(dashboard → Workers & Pages → each worker → Settings → Build → Connect to Git, via the Cloudflare
GitHub App). Production branch `master`; per-worker root dir `runner/apps/authoring` and
`runner/workers/api`. Non-production branches get preview URLs posted to the PR.

## Conventions / guardrails

- **No secrets in git.** Auth is the Handsontable Google login broker (per-user token, sessionStorage). Dev bypasses live only in gitignored `.env.local` / `.dev.vars`.
- Use **wrangler + the main CF account id** above for any Cloudflare resource (D1 `DB`, KV `CACHE`, R2 `ARTIFACTS`).
- Keep the CodeSandbox **hosted** Sandpack bundler (self-hosting it stack-overflows on HOT v18).
- Tier-2 containers stay warm while a tab is open (client keepalive + `sleepAfter=5m`); disk is ephemeral, so a slept container cold-boots on return.
- **Cost guardrails** (DEV-2030, ADR-0022): `max_instances` 5/3 is the container cap — don't raise it without redoing the arithmetic in `docs/cost-guardrails.md`. Spend degrades live sessions in stages while static shares keep serving. The dollar thresholds and the enforcement switch are **editable at runtime in `/admin`** (stored in `runner_settings`); the `BUDGET_*` vars are only defaults.
- **Ask AI** (DEV-2047, `docs/example-chat.md`): chat panel scoped to the open example; docs chunks are retrieved **in the browser** (Cloudflare blocks Worker→workers.dev, error 1042), the Worker adds Algolia page links and calls LiteLLM. Model edits are proposed, never auto-applied, and every answer is metered into the cost ledger.
- **Style panel** (DEV-2047, `docs/style-panel.md`): Theme Builder's controls applied to the open example via Handsontable's **JS theme API** (`registerTheme`/`params`), written into the demo as a real module and wired into the grid; `POST /api/theme` does natural-language styling.
- **Analytics are anonymous by construction** — no cookies, no IPs, no user agents, no query strings, no per-request rows; unique visitors use a daily-rotating salted hash. Keep it that way when touching `workers/api/src/analytics.ts`.
- No manual `handsontable/dist/*.css` imports in examples (not needed since 17.1; use `handsontable/styles/*`).
