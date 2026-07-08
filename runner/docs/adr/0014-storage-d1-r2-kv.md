# ADR-0014: Storage split: D1 + R2 + KV

**Status:** Accepted

## Context
We store demo metadata, source snapshots, built artifacts, and want an edge cache.

## Decision
- **D1** — demo metadata + short ids (`demos`, `build_cache`).
- **R2** — source snapshots + built static artifacts.
- **KV** — edge read-cache for demo JSON (`stale-while-revalidate`).
Immutable assets get `Cache-Control: public, max-age=31536000, immutable`.

## Consequences
- Clear separation of concerns; artifacts cacheable forever by build key.
- R2 must be enabled on the account (a one-time dashboard step).
