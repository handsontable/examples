# Architecture

## Goal

Replace CodeSandbox (too expensive) and the `render-ms` redirect microservice
with a self-hosted system that (a) renders every example live at any Handsontable
version, (b) lets internal team members edit code on the fly, and (c) produces a
clean, permanent client URL to share.

## One UX, two engines behind an adapter

The editor shell binds only to the `DemoRuntime` interface
(`packages/runtime/src/types.ts`). `resolveRuntime(entry)` selects the engine by
tier:

```
DemoRuntime
 ├─ SandpackRuntime   (Tier 1) — @codesandbox/sandpack-client, in-browser bundler
 └─ ContainerRuntime  (Tier 2) — WebSocket to a Cloudflare Sandbox session;
                                 iframe = container preview URL
```

- **Tier 1 — client-side (free, fastest):** `example1`, `javascript`,
  `typescript`, `react`, `vue`. Bundles in the browser; no server; tens-of-ms
  edit latency; zero compute cost.
- **Tier 1 via the container engine:** `react-js`, `ant-design`, `mui`,
  `base-web`. Still tier 1 (no SSR), but routed through the same container
  engine as Tier 2 so they render exactly as authored (real Vite dev server)
  instead of through Sandpack's in-browser bundler.
- **Tier 2 — SSR / meta-framework:** `angular`, `next.js`, `next-shadcn.js`,
  `astro`, `nuxt`, `remix`. A per-session container runs the framework's real
  `npm run dev` with HMR; edits stream over WebSocket; the preview iframe points
  at the container's preview URL. Auto-sleeps after inactivity.

> Angular is Tier 2: the Angular versions used here need a real Node backend/dev
> server rather than Sandpack's in-browser Angular template.

## Version dispatch

`applyHandsontableVersion(files, version)` (`packages/runtime/src/version.ts`)
rewrites `package.json` so `handsontable` and its framework wrapper are pinned in
lockstep to the requested version — before mount (Tier 1) or build (Tier 2).
`@handsontable/pikaday` is never rewritten. Inputs accepted (ported from
`render-ms`): semver (incl. npm-style partials like `17.0`), a bare pkg.pr.new
numeric id, or a `https://pkg.pr.new/...` URL. Major capped at
`HANDSONTABLE_MAX_MAJOR` (default 19). Supported wrapper range: majors 15–19
(pre-15 used different wrapper package names — out of scope).

Per-framework wrapper map (pinned in lockstep with `handsontable`):

| Framework(s) | Wrapper pinned |
|---|---|
| `example1`, `javascript`, `typescript`, `astro` | (core only) |
| `react`, `react-js`, `ant-design`, `mui`, `base-web`, `next.js`, `next-shadcn.js`, `remix` | `@handsontable/react-wrapper` |
| `vue`, `nuxt` | `@handsontable/vue3` |
| `angular` | `@handsontable/angular-wrapper` |

## Sharing model — cost stays bounded

Client-facing shares are **prebuilt static, never live sessions**. On Share:
snapshot files → run the real framework build → upload to R2 → mint a short id →
return a permanent `/d/:id` URL. Immutable, permanent, revocable (410 when
revoked). No container runs for client views.

### Internal "My demos" + fork flow

Authoring is **internal-team only** (Handsontable accounts — see Auth below).
Every signed-in user has their own set of demos stored in D1 (`created_by` =
their email). The create flow is a **fork**:

1. Open any existing demo as a starting point — a catalog starter template *or*
   another saved demo (`forked_from` records the source).
2. Edit the code live in the shell; set a **title** and **description**.
3. **Save** → `POST /api/demos` snapshots the files, builds the static artifact,
   stores metadata in D1 + artifact in R2, and mints a **unique short URL**
   `/d/:id` to send to the client.

The fork is independent and owned by the forker; editing it never affects the
source. "My demos" is `GET /api/demos?mine=1` filtered by `created_by`.

Static build modes per Tier-2 framework:

| Framework | Build for share | Static output |
|---|---|---|
| `angular` | `ng build` | `dist/*/browser` |
| `next.js`, `next-shadcn.js` | `next build` (`output: 'export'`) | `out/` |
| `astro` | `astro build` | `dist/` |
| `nuxt` | `nuxt generate` | `.output/public/` |
| `remix` | `remix vite:build` (SPA mode, `ssr: false`) | `build/client/` |

A built artifact is immutable per `(framework, ht_version, files_hash)` — cached
forever.

## Storage

- **D1** — demo metadata + short ids (see schema below).
- **R2** — source snapshots + built artifacts.
- **KV** — edge read-cache for demo JSON (`stale-while-revalidate`).

### D1 schema

```sql
CREATE TABLE demos (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,                              -- author-provided, shown to client
  framework    TEXT NOT NULL,
  tier         INTEGER NOT NULL,
  ht_version   TEXT NOT NULL,
  files_hash   TEXT NOT NULL,
  r2_prefix    TEXT NOT NULL,
  forked_from  TEXT,                              -- source demo id, or "catalog:<framework>"
  visibility   TEXT NOT NULL DEFAULT 'unlisted',
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,                     -- @handsontable.com email (from broker)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_demos_framework ON demos(framework);
CREATE INDEX idx_demos_created_by ON demos(created_by);      -- powers "My demos"
CREATE INDEX idx_demos_forked_from ON demos(forked_from);
CREATE UNIQUE INDEX idx_demos_buildkey ON demos(framework, ht_version, files_hash);

CREATE TABLE build_cache (
  build_key  TEXT PRIMARY KEY,
  r2_prefix  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

## Auth — Handsontable accounts only (login broker)

Authoring and all write endpoints are **internal-team only**, gated by the shared
Handsontable **Google login broker** (per the `publish-app` skill). This
supersedes the original spec's Cloudflare Access.

- Broker base URL (public, hardcoded — not a secret):
  `https://mcp-auth-proxy-j0tb.onrender.com`.
- Frontend redirects to `GET /broker/login?return_to=<app url>`; the broker
  authenticates via Google, **rejects any non-`@handsontable.com` account**, and
  redirects back with `#token=<JWT>`. The app stores the token in
  `sessionStorage`, resolves identity via `GET /broker/userinfo` →
  `{ email, sub, exp }`, and shows the signed-in email + a **Log out** control.
- `return_to` must be on an allowed host (`*.workers.dev`, `handsontable.com`,
  localhost) — satisfied by deploying on the main Handsontable account's
  `*.workers.dev` subdomain (account `15111272c53ed0aaf84a908f0c9c7f8b`, **not**
  the sandbox). See `docs/cloudflare-resources.md`.
- **Server-side:** the `workers/api` write endpoints (`POST`/`PATCH`/`DELETE
  /api/demos`) require `Authorization: Bearer <token>`, re-validate it against
  `/broker/userinfo`, and set/enforce `created_by` from the verified email. No
  service account, no app-wide credential — the per-user token is the credential.

`GET /api/demos/:id`, the viewer, and the embed view are **public** (read-only).

### Domains

- Authoring + API + viewer/embed deploy to the main Handsontable account's
  `*.workers.dev` subdomain (broker allowed host; no per-app Google setup).
- A vanity `demos.handsontable.com` can front the viewer later via routing; the
  short-link contract `/d/:id` is host-independent.

## Embedding on the docs (locked to handsontable.com)

Demos must be embeddable as an iframe on docs pages such as
`https://handsontable.com/docs/angular-data-grid/recipes/themes/ant-design/`, and
**only** from `handsontable.com` — no other site may embed them.

- `GET /embed/:id` serves the read-only rendered preview (no editor chrome),
  prebuilt-static from R2 — same cheap artifact as `/d/:id`.
- Embedding is restricted with a response header:
  `Content-Security-Policy: frame-ancestors https://handsontable.com https://*.handsontable.com http://localhost:*`.
  `frame-ancestors` is the authoritative, cross-origin-capable control (it
  supersedes `X-Frame-Options`, which can't allow a specific third-party origin).
- Defense in depth: reject when `Sec-Fetch-Dest: iframe` is present with a
  cross-site `Sec-Fetch-Site` and the `Origin`/`Referer` is not a
  `handsontable.com` host.
- The `/d/:id` share link (client-facing, opened directly) stays framable-nowhere
  by default; `/embed/:id` is the docs-only framed variant.

### Generating the embed URL is login-gated

The **"Copy embed URL / Generate embeddable link"** control is shown **only to
signed-in internal users** (broker session present) in the authoring / "My demos"
UI — it is not exposed to anonymous visitors of a `/d/:id` page. Serving the embed
(the docs iframe fetching `/embed/:id`) stays public but frame-locked to
`handsontable.com`; only the *act of minting/copying* the embeddable URL is behind
the Handsontable login. So: internal user signs in → opens/creates a demo →
generates the embed URL → pastes it into a docs page.

## Hard constraints

No Nodebox / WebContainers (Tier 2 runs the real open-source frameworks in our
own Cloudflare containers). White-label — no CodeSandbox marks in the UI. Secrets
in environment variables only. No per-view compute cost.

## Relationship to `render-ms`

`render-ms` has been **removed** — this runner fully replaces it. Its
`handsontable-version` dispatch logic was ported into `packages/runtime/version.ts`,
which accepts the same version inputs (semver, npm-style partials, pkg.pr.new refs).

## Documentation-guide examples

Beyond the 15 starter templates, the runner serves every example in the
Handsontable documentation guides (`handsontable/docs/content/guides/**/example*.*`).
`pipeline/import-docs.mjs` walks the docs repo, parses each `::: example` directive,
wraps every framework fragment into a minimal runnable project
(`pipeline/wrap-docs-example.mjs`), and emits `apps/authoring/public/docs-examples/`
(a `manifest.json` + one CatalogEntry JSON per example). The authoring app groups
them in the example picker by docs-folder breadcrumb and opens one via
`?docs=<content-path>` (e.g. `?docs=guides/columns/column-adding/react/example1.tsx`).
JavaScript/TypeScript/React run on Tier-1 (Sandpack); Vue and Angular run on Tier-2
(container, real dev server) because the classic in-browser bundler cannot compile
Vue 3 `<script setup>` or modern Angular. See `docs/docs-examples.md`.

## Deliverables

1. ✅ Monorepo scaffold + catalog importer + migration of all 15 examples.
2. ✅ `packages/runtime`: `SandpackRuntime` (Tier 1) for all 7 client-side frameworks.
3. ✅ `packages/editor-shell` + `apps/authoring`: unified editor (Tier-1 live). *(auth
   broker + fork/title/description UI wired in with the sharing API, D5.)*
4. Tier 2: `containers/*` + `ContainerRuntime` + Sandbox SDK orchestration.
5. ✅ `workers/api`: Handsontable-broker auth on writes; `POST/GET/PATCH/DELETE
   /api/demos` (fork → title/description → snapshot → build → R2 → short id);
   "My demos" by `created_by`; D1/R2/KV. Deployed.
6. ✅ Public `/d/:id` read-only viewer **and** `/embed/:id` locked to
   `handsontable.com` via `frame-ancestors` (served by the Worker from R2).
7. ✅ Build snapshotter (builder container) + version injection. `scripts/warm.ts`
   (prebuild N versions) still to add.
8. ✅ `render-ms` removed (its version-dispatch logic lives in `version.ts`).
9. ✅ `docs/`: run-and-deploy, self-host-bundler, create-and-share-a-demo,
   cloudflare-resources, docs-examples, ADRs.
10. ✅ Documentation-guide examples: `import-docs.mjs` + `wrap-docs-example.mjs`
    → `docs-examples/`, opened via `?docs=`.

Deployed: API `handsontable-demos-api.handsoncode.workers.dev`, authoring
`handsontable-demos-authoring.handsoncode.workers.dev`. Pending: wildcard domain
for live Tier-2 (ADR-0011), broker redeploy for `handsoncode.workers.dev`
logins, `scripts/warm.ts`.
```
