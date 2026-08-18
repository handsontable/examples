# Architecture

## Goal

Replace the third-party sandbox service and the `render-ms` redirect microservice
with a self-hosted system that (a) renders every example live at any Handsontable
version, (b) lets an author edit code on the fly, and (c) produces a clean,
permanent URL to share. Self-hosting also puts per-view cost, version coverage
and the look of the editor under our own control.

## One UX, two engines behind an adapter

The editor shell binds only to the `DemoRuntime` interface
(`packages/runtime/src/types.ts`) and branches on one field, `entry.engine`. That
field is **not** derived from the tier at render time: it is authored per framework
in `config/frameworks.json` and only *defaults* from the tier when the catalog is
generated (`engine: cfg.engine ?? (cfg.tier === 2 ? "container" : "sandpack")`,
`pipeline/import.mjs`). Five tier-1 starters deliberately override it to
`"container"` (see below), so "tier 1 means Sandpack" is false — read `engine`.

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
  `base-web`, `fluent-ui`. Still tier 1 (no SSR), but routed through the same
  container engine as Tier 2 so they render exactly as authored (real Vite dev
  server) instead of through Sandpack's in-browser bundler.
- **Tier 2 — SSR / meta-framework:** `angular`, `next.js`, `next-shadcn.js`,
  `astro`, `nuxt`, `remix`. A per-session container runs the framework's real
  `npm run dev` with HMR; edits stream over WebSocket; the preview iframe points
  at the container's preview URL. Auto-sleeps after inactivity.

> Angular is Tier 2: the Angular versions used here need a real Node backend/dev
> server rather than Sandpack's in-browser Angular template.

### Why the Tier-2 dev server needs an allowed-hosts opt-in (DEV-2541)

The Sandbox SDK's preview proxy shows the dev server two different `Host` values
depending on the request (`buildPreviewProxyRequest`):

| request | what the dev server sees |
| --- | --- |
| ordinary HTTP | rewritten to `http://localhost:<port>` |
| WebSocket upgrade | the **original** preview host, `<port>-<session>-<token>.demos.handsontable.com` |

Vite gates both on `server.allowedHosts`, which defaults to `[]`. The rewrite
means the page always passes the check, so previews render; the upgrade does not,
so vite refuses the HMR socket with a `400` and live editing silently stops
reloading. That asymmetry is why the bug survived unnoticed until browser consoles
started reporting it — nothing about the preview *looks* broken.

The opt-in is the `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` environment variable,
derived from `PREVIEW_HOST` in `workers/api/src/preview-allowed-hosts.ts` and
handed to the dev-server process via `startProcess({ env })`. The value carries a
leading dot (`.demos.handsontable.com`), which vite treats as a suffix wildcard,
so one static string covers every per-session preview hostname. Vite applies it
only when `server.allowedHosts` is still an array, so it is a no-op for the
starters that already set `allowedHosts: true` (react-js, ant-design, mui,
base-web, fluent-ui, remix, astro). Angular is covered too, via the builder chain
its `angular.json` actually names: `@angular-devkit/build-angular:dev-server` sees
an `:application` build target, takes its esbuild branch, normalises an unset
`allowedHosts` to `[]`, and hands that array to `@angular/build`'s `serveWithVite`,
which passes it straight into the vite server config. Angular's own host-check
middleware only prettifies vite's 403; it delegates the decision to vite. Nuxt is
expected to be covered by the same array default but has not been observed.

Three things to know before changing any of this:

- **It is not a `server.hmr` problem.** With no `server.hmr` config the HMR client
  derives host, port and protocol from `import.meta.url` and already dials
  `wss://<preview-host>/` correctly. Adding `--hmr.clientPort` / `--hmr.protocol`
  to a dev command does not help and actively breaks the session: vite's CLI
  declares no `--hmr` option, so it aborts with `CACError` before it ever listens,
  and the session then serves the boot-failure page forever. Vite's own console
  diagnostic is what sends people down that path — `[vite] failed to connect to
  websocket … (browser) <preview>:/ <--[WebSocket (failing)]--> localhost:5173/
  (server)` does *not* mean the client dialed `localhost:5173`. In
  `dist/client/client.mjs` the right-hand side of both lines is `serverHost` /
  `directSocketHost`, a static label for where the dev server bound; the browser
  side of the failing line is the preview host, and it is already correct.
- **`shouldHandle` refuses on two gates that look identical on the wire.** Both the
  host check and — whenever the request carries an `Origin`, which a browser always
  sends on a WebSocket handshake — the `?token=` check against the value vite bakes
  into `/@vite/client` abort with a bare `400`. Only the host gate is broken here,
  but a change that satisfied just that gate would be indistinguishable from one
  that actually restores HMR. That is why the guard test drives the whole
  browser-shaped handshake (preview `Host`, matching `Origin`, real token) and not
  only the host check.
- **The variable is internal to vite and unversioned, and it has already changed.**
  vite 6.4.3 and 7.3.5 append the value verbatim; 8.1.1 splits it on commas and
  discards it entirely — warning only, no error — if it contains `\`, `"` or `'`.
  Every failure here is silent: HMR just goes back to being broken.
  `pipeline/vite-allowed-hosts.test.mjs` is what would notice. It boots a real vite
  and drives a real upgrade handshake with a preview-shaped `Host`, asserting `400`
  without the variable and `101` with it — once with `Origin` omitted to isolate the
  host gate, and once in full browser shape to prove the handshake a browser
  actually sends completes — and separately pins the value's shape against vite 8's
  parsing rules.

> **There is no single container vite version.** Three are in play: the repo (and
> therefore the test) installs **6.4.3**; Angular runs **7.3.5**, pinned by
> `@angular/build` rather than by the starter; and a booted react-js container was
> observed on **8.1.1**, since each starter pins its own. All three default
> `allowedHosts` to `[]`, honour the leading-dot wildcard, and read the variable, so
> the fix holds across them — but the *behavioural* half of the guard only ever
> exercises 6.4.3. Booting the containers' own vite in CI would close that gap.

## Version dispatch

`applyHandsontableVersion(files, version)` (`packages/runtime/src/version.ts`)
rewrites `package.json` so `handsontable` and its framework wrapper are pinned in
lockstep to the requested version — before mount (Tier 1) or build (Tier 2).
`@handsontable/pikaday` is never rewritten (nor is upstream `pikaday`, which the
docs Pikaday recipe moved to — its name does not match the rule). Inputs accepted (ported from
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

- **D1** — demo metadata + short ids, and user profiles (see schema below).
- **R2** — source snapshots + built artifacts, and profile avatars.
- **KV** — edge read-cache for demo JSON (`stale-while-revalidate`), and the
  `payload:<id>` records an ad-hoc example boots from (24h TTL, no D1 row — see
  below). Deliberately the throwaway tier: nothing here survives its expiry, and
  nothing here is what a user is asked to keep.

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

CREATE TABLE profiles (                            -- DEV-2166, migration 0005
  email        TEXT PRIMARY KEY,                   -- same key space as demos.created_by
  display_name TEXT,                               -- NULL -> derive from the email
  description  TEXT,
  avatar_key   TEXT,                               -- opaque uuid -> R2 avatars/<key>
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

### Profiles (`/settings`)

The signed-in user's name, description and avatar, behind
`GET`/`PUT /api/profile` and `POST`/`DELETE /api/profile/avatar`. Every statement
binds the caller's verified email and no route accepts one as input, so there is
no cross-user surface to guard.

There is no user table to key on: the broker's `sub` is fetched but never stored,
so email is the only stable identifier the system holds. `NULL` means "never set,
or cleared" — the reader derives the default rather than storing one, so clearing
a field reverts to it instead of showing a blank.

The derived name comes from the address itself: team accounts are issued as
`name.surname@handsontable.com`, so `artur.medrygal` reads as `Artur Medrygal`
(ADR-0007). There is no derived *picture* — an uploaded avatar or the monogram.

Avatars live in the existing `ARTIFACTS` bucket under `avatars/<key>`, alongside
but never colliding with `demos/<id>/`. The key is a random uuid rather than the
email: the read route (`GET /api/profile/avatar/:key`) is public because it is an
`<img src>` on pages that carry no token, and an email-keyed URL space would
enumerate the team. A fresh key per upload also makes the image immutably
cacheable; the previous object is deleted on re-upload, since nothing sweeps that
prefix. Uploads are accepted on **magic bytes** (PNG/JPEG/WebP), never on the
request's `Content-Type` — what the sniff returns is what gets stored as
`httpMetadata` and echoed back to a browser.

Defaults from Google SSO are *not* available: the broker requests
`scope=openid email`, so `/broker/userinfo` returns no `name` or `picture` — the
claims are never requested, so there is nothing to parse. Names come from the
address's own structure instead; see ADR-0007.

## Auth — Handsontable accounts only (login broker)

Authoring and all write endpoints are **internal-team only**, gated by the shared
Handsontable **Google login broker** (per the `publish-app` skill). This
supersedes the original spec's Cloudflare Access.

- The broker base URL is deployment config (`LOGIN_BROKER_URL`), not a secret.
- The frontend hands off to the broker, which authenticates via Google,
  **rejects any non-`@handsontable.com` account**, and redirects back with a JWT.
  The app keeps that token in `sessionStorage`, resolves identity from it, and
  shows the signed-in email plus a **Log out** control. The exact endpoints and
  parameters live in `apps/authoring/src/auth.ts`.
  The broker's authorize redirect requests `scope=openid email` only, so there is
  no `name` or `picture` claim to be had — display names are derived from the
  address's `name.surname` shape and avatars come from the `profiles` table
  (ADR-0007).
- `return_to` must be on an allowed host (`*.workers.dev`, `handsontable.com`,
  localhost) — satisfied by deploying on the main Handsontable account's
  `*.workers.dev` subdomain (**not** the sandbox). See
  `docs/cloudflare-resources.md`.
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

## Ad-hoc examples — `?payload=<id>`

Two paths open a workspace that is in no catalog: `?import=<url>`, where the Worker
fetches a JSFiddle or StackBlitz page and converts it (ADR-0032), and `?payload=<id>`,
where the *client* hands over a project it generated itself — today the Theme Builder,
which used to export to StackBlitz (DEV-2048).

`POST /api/payload` takes `{ files, title?, framework? }`, validates it
(`validatePayloadFiles`: workspace-safe paths, text only, no `.env`, 80 files, 256 KB,
and `assertHandsontableProject` — the same Handsontable-only rule imports get),
resolves the starter with `detectFramework`, and stores the record in KV under
`payload:<id>` for 24 hours. The playground boots from `GET /api/payload/:id`, opens
the files unsaved — exactly as after a fork — and strips the param so a reload cannot
reinstall them over the author's edits. A miss is a 404 and is worded as an expiry:
KV cannot distinguish the two, and there is nothing here worth a tombstone.

Unlike `/api/import`, the route is **public**. Import is authenticated because it
makes the Worker fetch a user-supplied URL (`resolveSource` is the host gate); a
payload fetches nothing, and Theme Builder users are anonymous, so the gate is the
rate limit plus those ceilings. Nothing durable is created either way: a payload the
author wants to keep is one **Save** away from being a real demo, and that Save is
what mints the D1 row (with `forked_from = "payload:theme-builder"`).

## Deliverables

1. ✅ Monorepo scaffold + catalog importer + migration of all 16 examples.
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
9. ✅ `docs/`: run-and-deploy, self-host-bundler, `guide/` (the four role-based
   tracks rendered at `/guide`, ADR-0034), cloudflare-resources, docs-examples, ADRs.
10. ✅ Documentation-guide examples: `import-docs.mjs` + `wrap-docs-example.mjs`
    → `docs-examples/`, opened via `?docs=`.

Deployed: API `handsontable-demos-api`, authoring
`handsontable-demos-authoring`, both on demos.handsontable.com. Pending:
wildcard domain for live Tier-2 (ADR-0011), broker allowlist entry for the
account's `workers.dev` logins, `scripts/warm.ts`.
```
