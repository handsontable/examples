# Handsontable Demo Runner

Self-hosted system that renders every Handsontable example — including every
documentation-guide example — live at any Handsontable version, lets you edit the
code on the fly, and produces clean, permanent URLs to share. It runs the demos on
Handsontable's own infrastructure instead of a third-party sandbox service, and
replaced the former `render-ms` redirect microservice (removed).

Live at **https://demos.handsontable.com**.

> See `docs/architecture.md` for the full design and
> [`docs/docs-examples.md`](docs/docs-examples.md) for how the documentation-guide
> examples are imported and opened in the runner (`?docs=` URLs).

## One UX, two engines

A single editor shell binds only to the `DemoRuntime` interface. Which engine
sits behind it is invisible to the author:

- **Tier 1 — client-side (Sandpack, in-browser bundler, free):**
  `example1`, `javascript`, `typescript`, `react`, `vue`.
- **Tier 1 via the container engine (real Vite dev server, still no SSR):**
  `react-js`, `ant-design`, `mui`, `base-web`, `fluent-ui` — these render exactly as authored.
- **Tier 2 — SSR / meta-framework (Cloudflare Sandbox container running the real
  dev server):** `angular`, `next.js`, `next-shadcn.js`, `astro`, `nuxt`, `remix`.

## Layout

| Path | Purpose |
|------|---------|
| `config/frameworks.json` | Single source of truth: tier, wrappers, dev/build commands, ports per example. |
| `catalog.json` | Generated. All 16 examples normalized into starting templates. |
| `pipeline/` | `import.mjs` (starter catalog), `import-docs.mjs` + `wrap-docs-example.mjs` (documentation-guide examples). |
| `packages/runtime/` | `DemoRuntime` interface + its two implementations (`sandpack.ts`, `container.ts`), `applyHandsontableVersion`. |
| `packages/editor-shell/` | Framework-agnostic editor UI + branding `theme.ts`. |
| `apps/authoring/` | Vite+React authoring app (behind Cloudflare Access). |
| `workers/api/` | Sharing + Tier-2 orchestration Worker. Also serves the prebuilt static demos from R2: `/d/:id` (public viewer) and `/embed/:id` (docs-only embed). |
| `containers/` | One Dockerfile per Tier-2 framework (deps baked in). |
| `scripts/` | Migration + warming. |
| `docs/` | Architecture, self-host-bundler, run/deploy, non-technical guide, plus `adr/` (decision records) and `reports/`. |

## Regenerate the catalog

```bash
node pipeline/import.mjs        # reads ../examples/, writes catalog.json
node pipeline/import-docs.mjs   # reads ../../handsontable/docs, writes apps/authoring/public/docs-examples/
```

## Constraints

No Nodebox / WebContainers. White-label — the Tier-1 engine uses the open-source
[Sandpack](https://sandpack.codesandbox.io/) bundler, with no third-party branding
in the UI. Secrets live in environment variables and Cloudflare secrets, never in
the repo. See `docs/architecture.md`.
