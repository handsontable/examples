# ADR-0004: Angular is Tier 2

**Status:** Accepted

## Context
Sandpack ships an Angular template pinned to ~Angular 10; our examples are Angular
21 (standalone APIs). Live Angular editing in Sandpack would not bundle 1:1.

## Decision
Treat Angular as Tier 2 — run the real Angular dev server in a container, like the
SSR frameworks.

## Consequences
- Tier 1 = 7 frameworks; Tier 2 = 6 (adds Angular).
- Angular gets its own container image + dev command (`ng serve`).
