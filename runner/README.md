# Handsontable Demo Runner

Self-hosted system that renders every Handsontable example — including every
documentation-guide example — live at any Handsontable version, lets internal team
members edit code on the fly, and produces clean, permanent client URLs to share.
Replaces CodeSandbox and the former `render-ms` redirect microservice (removed).

> See `docs/architecture.md` for the full design and
> [`docs/docs-examples.md`](docs/docs-examples.md) for how the documentation-guide
> examples are imported and opened in the runner (`?docs=` URLs).

## One UX, two engines

A single editor shell binds only to the `DemoRuntime` interface. Which engine
sits behind it is invisible to the author:

- **Tier 1 — client-side (Sandpack, in-browser bundler, free):**
  `example1`, `javascript`, `typescript`, `react`, `vue`.
- **Tier 1 via the container engine (real Vite dev server, still no SSR):**
  `react-js`, `ant-design`, `mui`, `base-web` — these render exactly as authored.
- **Tier 2 — SSR / meta-framework (Cloudflare Sandbox container running the real
  dev server):** `angular`, `next.js`, `next-shadcn.js`, `astro`, `nuxt`, `remix`.

## Layout

| Path | Purpose |
|------|---------|
| `config/frameworks.json` | Single source of truth: tier, wrappers, dev/build commands, ports per example. |
| `catalog.json` | Generated. All 15 examples normalized into starting templates. |
| `pipeline/` | `import.mjs` (starter catalog), `import-docs.mjs` + `wrap-docs-example.mjs` (documentation-guide examples). |
| `packages/runtime/` | `DemoRuntime` interface, `applyHandsontableVersion`, `resolveRuntime`. |
| `packages/editor-shell/` | Framework-agnostic editor UI + branding `theme.ts`. |
| `apps/authoring/` | Vite+React authoring app (behind Cloudflare Access). |
| `apps/viewer/` | Public read-only viewer for `/d/:id`. |
| `workers/api/` | Sharing + Tier-2 orchestration Worker. |
| `containers/` | One Dockerfile per Tier-2 framework (deps baked in). |
| `scripts/` | Migration + warming. |
| `docs/` | Architecture, self-host-bundler, run/deploy, non-technical guide. |

## Regenerate the catalog

```bash
node pipeline/import.mjs        # reads ../examples/, writes catalog.json
node pipeline/import-docs.mjs   # reads ../../handsontable/docs, writes apps/authoring/public/docs-examples/
```

## Constraints

No Nodebox / WebContainers. White-label (no CodeSandbox marks). Secrets in env
only. Private repo under `handsontable`. See `docs/architecture.md`.
