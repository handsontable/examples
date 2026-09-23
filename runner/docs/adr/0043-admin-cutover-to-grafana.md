# ADR-0043: `/admin` reads move to Grafana; the writes stay on `/admin/controls`

**Status:** Proposed — design approved 2026-09-23 (revision 2). Follows ADR-0041 after launch; amends ADR-0022.

## Context

`/admin` is one page (`apps/authoring/src/Admin.tsx`) over these API routes:

| Route | Kind | Used for |
|---|---|---|
| `GET /api/admin/usage?days=N` | read | spend, tier, SKUs, daily spend and activity, demos, AI assistant, audience, first page of live sessions |
| `GET /api/admin/sessions` | read | live-session paging and the 24 h tail |
| `GET /api/admin/settings` | read | effective guardrail settings and whether they are overrides |
| `PUT /api/admin/settings` | write | save guardrail settings |
| `DELETE /api/admin/settings` | write | reset to defaults |
| `DELETE /api/admin/sessions/:ref` | write | kill a live session |

Every read comes from D1 or KV. Grafana has no D1 datasource and cannot be trusted to
stay read-only on its own: any Viewer can make the Infinity plugin send arbitrary requests,
POST included, to any host the datasource allows. A service-binding HTTP fetch lands in
the same handler as public `/api` traffic, so "internal" cannot be a header.

## Decision

1. **Reads over RPC, not HTTP.** The API worker exposes a `WorkerEntrypoint` class
   `AdminReads` with one method per read (`usage`, `sessions`, `settings`,
   `costLedger`). It is reachable only through a service binding with
   `entrypoint: "AdminReads"` from the o11y worker, never from the public fetch handler.
2. **A read-only forwarder.** The o11y worker serves `GET /grafana/_o11y/admin/<name>`
   behind the same Access check as Grafana, maps `<name>` onto exactly those methods and
   answers 404 to any other name and 405 to any other method. The Infinity datasource's
   allowed-hosts list holds only this forwarder. No admin token exists in Grafana.
3. **Panels**: Cost (moved here from ADR-0041: spend from `cost_ledger`, app /
   observability / total, per SKU, estimate vs billing), Audience (unique visitors stay
   D1-only — the salted hash table is the honest source and the 180-day rule governs it),
   demos inventory, AI assistant, live sessions, and budget-tier history from ADR-0041's
   `budget.gauge`. `example_daily` (ADR-0042) gets its long-range panel here.
4. **`/admin/controls`** keeps the writes and the quick look: the settings form with
   reset, the live-sessions table with kill, and the three budget numbers. The manual
   inbox re-open stays on `/grafana/_o11y/reopen` (ADR-0041 §B.3).
5. **Equivalence instead of a comparison week.** Grafana panels and `/admin` read the same
   D1 rows, so the risk is the panel's query and transform, not the data. A test renders
   both from one D1 fixture and asserts equal totals per panel (counts to the unit, USD to
   the cent); one production spot check then compares the two for the same day. When
   both pass, `/admin` redirects to Grafana through Access and the read half of
   `Admin.tsx` is deleted.

## Consequences

- ADR-0022's `/admin` becomes `/admin/controls`; runtime-editable guardrails are
  unchanged.
- The API worker gains an RPC entrypoint; the o11y worker gains a second service binding
  to it and a forwarder with an allowlist.
- A quick look at spend no longer needs Grafana's cold start: the three numbers stay on
  `/admin/controls`.
- Tests: the forwarder refuses unknown names and non-GET methods; the public fetch handler
  cannot reach `AdminReads`; the equivalence test per panel; `/admin/controls` with
  `VITE_DEV_USER` cleared.
