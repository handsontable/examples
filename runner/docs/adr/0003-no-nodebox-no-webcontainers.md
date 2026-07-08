# ADR-0003: No Nodebox / WebContainers

**Status:** Accepted

## Context
In-browser Node runtimes (StackBlitz WebContainers, CodeSandbox Nodebox) are
commercially licensed / closed. The Nodebox public repo is only the client API;
the engine is a hosted closed blob.

## Decision
Do not depend on Nodebox or WebContainers. Tier 2 runs the real open-source
frameworks inside our own Cloudflare Sandbox containers. A `grep` for
`nodebox`/`webcontainer` must stay clean (excluding prose that forbids them).

## Consequences
- No licensing exposure; full control of the Tier-2 runtime.
- Tier 2 needs container infrastructure (Cloudflare Containers/Sandbox SDK).
