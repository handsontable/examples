# T13 — ADR-0043 `/admin` cutover and Cost dashboard

| | |
|---|---|
| Status | deferred — last, after launch (decision 2026-09-23) |
| Size | M |
| Depends on | T03, T04, T09, and the launch |
| ADR | [0043](../../docs/adr/0043-admin-cutover-to-grafana.md) revision 2 in full |
| Owns | the `AdminReads` `WorkerEntrypoint` in the API worker, the second `API` binding (`entrypoint: "AdminReads"`), the `/grafana/_o11y/admin/<name>` forwarder, the Infinity datasource with its allowed-hosts list, the Cost / Audience / demos / AI / sessions / tier-history panels, `/admin/controls`, the `/admin` redirect, deletion of the read half of `Admin.tsx`, tests |

## Goal

Grafana becomes the read surface for what `/admin` shows; the writes and the three budget
numbers stay on `/admin/controls`.

## Acceptance criteria

- The forwarder answers only the allowlisted names, GET only; the public fetch handler
  cannot reach `AdminReads`; no admin token exists in Grafana config.
- The per-panel equivalence test renders Grafana's query and `/admin`'s aggregation from
  one D1 fixture and asserts equal totals (counts to the unit, USD to the cent); one
  production spot check for the same day passes before the redirect ships.
- `/admin/controls` renders settings with reset, the session kill and the budget numbers;
  its tests run with `VITE_DEV_USER` cleared.

## Outcome

_Filled in when done._
