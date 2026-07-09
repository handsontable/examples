# ADR-0006: Client shares are prebuilt-static, never live

**Status:** Accepted

## Context
If every share URL were a live session, cost would scale with client views.

## Decision
On Share: snapshot files → run the real framework build → upload to R2 → mint a
short id → return a permanent `/d/:id`. Client views serve immutable static
artifacts; no container runs for a viewer. Static build modes: Next
`output:'export'`, Nuxt `generate`, Remix SPA mode, Astro/Angular build.
A built artifact is immutable per `(framework, ht_version, files_hash)`.

## Consequences
- Client-view compute cost is zero; links survive redeploys; revocable (410).
- SSR features that require a running server are not available in a static share.
