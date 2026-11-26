# ADR-0043: `/admin` reads move to Grafana (rejected; `/admin` stays on D1/KV)

**Status:** Rejected 2026-11-09. Revision 2 proposed moving the `/admin` reads to Grafana
behind an RPC entrypoint and a read-only forwarder. Nothing from it was built.

## What was proposed

`/admin` (`apps/authoring/src/Admin.tsx`) would lose its read half: an `AdminReads`
`WorkerEntrypoint` on the API worker, a `GET /grafana/_o11y/admin/<name>` forwarder on the
o11y worker, an Infinity datasource, new Grafana panels for cost, audience, demos
inventory, AI assistant and live sessions, then a redirect to Grafana. The writes would
have moved to `/admin/controls`, and ADR-0022 would have been amended.

## Why it was rejected

1. **Most of `/admin` is D1/KV-only data.** Cost ledger, spend by SKU, demos inventory,
   audience (salted-hash tables under the 180-day rule), live-session meters and the
   guardrail settings are not in Analytics Engine, and Grafana has no D1 datasource.
   Showing them in Grafana needs the RPC entrypoint, the forwarder and an Infinity
   datasource, only to render what `/admin` already renders.
2. **Grafana cannot be trusted to stay read-only.** Any Viewer can make the Infinity plugin
   send arbitrary requests, POST included, to every host the datasource allows. A
   service-binding HTTP fetch lands in the same handler as public `/api` traffic, so
   "internal" cannot be a header. Hence RPC, plus a forwarder with an allowlist: real
   surface to build and keep safe for no new information.
3. **The observability stack cannot replace the counters either.** An audit on
   2026-11-09 compared D1 `usage_daily.session_started` with Analytics Engine
   `session.start` (outcome other than `budget_denied`) for each UTC day from 2026-09-29
   to 2026-11-09. Analytics Engine was lower on every one of the 42 days, by 10% to 70%
   (09-30: 1279 vs 293; 10-18: 2080 vs 1434; 11-04: 588 vs 228), against a 1% bar. The
   cause is not established: D1 counts at `index.ts` after the meter starts, Analytics
   Engine at the end of each attempt. `session_denied` has no rows in either store.
   `chat.answer` carries no framework or refusal-reason blob, so the assistant section's
   two breakdown lists cannot be reproduced from it. The other `usage_daily` metrics have
   no 1:1 Analytics Engine metric (views are de-duplicated in `noteView`; `serve.*` counts
   every serve).
4. **Analytics Engine history is short.** It starts 2026-09-29; a 90-day window is fully
   covered only from about 2026-12-29, so any shifted metric would need a per-day cutover.

## Decision

`/admin` and its six routes stay as they are, reading D1 and KV. Grafana keeps the
dashboards ADR-0041 provisions (budget tiers and chat are already there), and
`/admin` keeps its link to Grafana.

## Consequences

- ADR-0022 is not amended: `/admin` is not renamed.
- ADR-0041 §G and §J, and ADR-0042 (Context and decision 6), refer to this ADR as
  pending work. Read those references as "not happening". ADR-0042's long-range view from
  `example_daily` is no longer waiting on this ADR and has no owner until someone wants it.
- Reopen condition: if the `session.start` and `session_started` counts are made to agree
  within 1% over a few weeks, moving that one stat card to Analytics Engine becomes
  worth a small, separate ADR. The `AdminReads` / forwarder design is not part of that.
