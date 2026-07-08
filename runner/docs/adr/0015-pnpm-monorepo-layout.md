# ADR-0015: pnpm monorepo under `runner/`

**Status:** Accepted

## Context
The system spans a shared runtime, an editor UI, two apps, a Worker, container
images, and pipeline/scripts.

## Decision
A pnpm-workspace monorepo under `runner/`: `packages/{runtime,editor-shell}`,
`apps/{authoring,viewer}`, `workers/api`, `containers/*`, `pipeline/`, `scripts/`,
`docs/`, `config/frameworks.json` (single source of truth), generated
`catalog.json`.

## Consequences
- Shared types/logic via workspace packages; one install graph.
- `render-ms/` stays outside `runner/`, untouched (ADR-0017).
