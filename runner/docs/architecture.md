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
  `typescript`, `react`, `react-js`, `ant-design`, `vue`. Bundles in the browser;
  no server; tens-of-ms edit latency; zero compute cost.
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
| `react`, `react-js`, `ant-design`, `next.js`, `next-shadcn.js`, `remix` | `@handsontable/react-wrapper` |
| `vue`, `nuxt` | `@handsontable/vue3` |
| `angular` | `@handsontable/angular-wrapper` |

## Sharing model — cost stays bounded

Client-facing shares are **prebuilt static, never live sessions**. On Share:
snapshot files → run the real framework build → upload to R2 → mint a short id →
return `https://demos.handsontable.com/d/:id`. Immutable, permanent, revocable
(410 when revoked). No container runs for client views.

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
  framework    TEXT NOT NULL,
  tier         INTEGER NOT NULL,
  ht_version   TEXT NOT NULL,
  files_hash   TEXT NOT NULL,
  r2_prefix    TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'unlisted',
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_demos_framework ON demos(framework);
CREATE INDEX idx_demos_created_by ON demos(created_by);
CREATE UNIQUE INDEX idx_demos_buildkey ON demos(framework, ht_version, files_hash);

CREATE TABLE build_cache (
  build_key  TEXT PRIMARY KEY,
  r2_prefix  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

## Auth & domains

Cloudflare Access gates `apps/authoring` and all write endpoints. The viewer and
`GET /api/demos/:id` are public. Authoring lives on an Access-gated subdomain;
public shares at `demos.handsontable.com/d/:id`.

## Hard constraints

No Nodebox / WebContainers (Tier 2 runs the real open-source frameworks in our
own Cloudflare containers). White-label — no CodeSandbox marks in the UI. Secrets
in environment variables only. No per-view compute cost.

## Relationship to `render-ms`

`render-ms` keeps running until this system fully replaces it. This PR adds a
compatibility shim mapping old `render-ms` deep links
(`example-dir`, `handsontable-version`, `handsontable-branch`,
`handsontable-sha`, `example-branch`) to the new viewer; `render-ms` removal is a
follow-up PR.

## Deliverables

1. ✅ Monorepo scaffold + catalog importer + migration of all 13 examples.
2. `packages/runtime`: `SandpackRuntime` (Tier 1) for all 7 client-side frameworks.
3. `packages/editor-shell` + `apps/authoring`: unified editor behind Access.
4. Tier 2: `containers/*` + `ContainerRuntime` + Sandbox SDK orchestration.
5. `workers/api` sharing endpoints + D1/R2/KV.
6. `apps/viewer` at `/d/:id` + opt-in "Edit live".
7. `pipeline/` build-and-serve snapshotter + version injection + `scripts/warm.ts`.
8. `render-ms` compatibility shim.
9. `docs/`: run/deploy, self-host-bundler, non-technical share guide.
```
