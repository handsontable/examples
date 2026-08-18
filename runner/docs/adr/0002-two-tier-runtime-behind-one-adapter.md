# ADR-0002: Two-tier runtime behind one `DemoRuntime` adapter

**Status:** Accepted

## Context
Live editing splits by whether a framework needs a Node server. Client-side apps
can bundle in the browser; SSR/meta-frameworks need a real dev server. We still
want one identical editor UX.

## Decision
Define a single `DemoRuntime` interface (`mount`, `writeFile`, `onReady`,
`onError`, `dispose`). Two implementations: `SandpackRuntime` (Tier 1, in-browser
bundler) and `ContainerRuntime` (Tier 2, Cloudflare Sandbox container). The editor
shell binds only to the interface; `resolveRuntime(entry)` picks by tier.

## Consequences
- The author cannot tell which engine runs (met acceptance criterion).
- New engines can be added behind the same interface without touching the shell.
- Tier assignment lives in `config/frameworks.json`.

**As built (2026-08-18, DEV-2529):** the engine is picked per framework, not per
tier. `config/frameworks.json` carries an explicit `engine` (defaulted from the
tier once, at catalog generation) and five tier-1 starters ship
`engine: "container"`; the shell branches on `entry.engine` directly. The
`resolveRuntime(entry)` helper named above was never wired and has been removed.
