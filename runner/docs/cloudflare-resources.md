# Cloudflare resources

All resources live in the **main Handsontable Cloudflare account** (not the
sandbox).

- **Account:** `Handsontable Account` — `15111272c53ed0aaf84a908f0c9c7f8b`
- Dashboard: https://dash.cloudflare.com/15111272c53ed0aaf84a908f0c9c7f8b

| Kind | Name | ID | Binding | Notes |
|------|------|----|---------|-------|
| D1 | `handsontable-demos` | `5fc0854f-d348-487f-9531-2c44cc86d182` | `DB` | region EEUR; schema `migrations/0001_init.sql` applied |
| KV | `handsontable-demos-cache` | `6620876d996d45f9ac69b2a6b59909e6` | `CACHE` | edge read-cache for demo JSON |
| R2 | `handsontable-demos` | (name-addressed) | `ARTIFACTS` | created 2026-07-08 (R2 enabled on the account) |

All three resources are provisioned in account `15111272…`.

## Production deployment

- **API/orchestration Worker:** `handsontable-demos-api` →
  **https://handsontable-demos-api.handsoncode.workers.dev**
  (account workers.dev subdomain: `handsoncode.workers.dev`).
- **Authoring app (static SPA):** `handsontable-demos-authoring` →
  **https://handsontable-demos-authoring.handsoncode.workers.dev**
  (internal; gated by the Handsontable login broker).
- Deployed via `CLOUDFLARE_ACCOUNT_ID=15111272… npx wrangler deploy` from
  `workers/api/`. Migrations applied; D1/KV/R2 bound.
- **7 container applications** created (Sandbox SDK): `…-remixsandbox`,
  `-angularsandbox`, `-nextsandbox`, `-nextshadcnsandbox`, `-astrosandbox`,
  `-nuxtsandbox`, `-buildersandbox`.
- Verified live: `GET /api/health` → 200; unknown demo → 404; unauthenticated
  `POST /api/demos` → 401 (broker auth enforced; no dev bypass in prod).

### What works in prod now vs. pending

- ✅ **Static sharing + viewer** (`POST /api/demos`, `/d/:id`, `/embed/:id`,
  `GET /api/demos`) work on the `workers.dev` domain — no wildcard needed. The
  build snapshotter runs in the `buildersandbox` container.
- ⏳ **Live Tier-2 authoring sessions** (`/api/session*`) need a **wildcard custom
  domain** for container preview URLs (ADR-0011) — `*.workers.dev` does not
  support them. Set up e.g. `*.demos.handsontable.com` → this Worker, then live
  Tier-2 preview works. Static shares of Tier-2 demos already work (built via the
  builder container).

> Creating a share in prod requires a Handsontable broker login (browser flow);
> the static/build code path itself is verified locally end-to-end.

## Billing + cost guardrails

- **Budget alerts** at **$200 / $500 / $800** — Manage Account → Billing →
  Billable Usage → *Set Budget Alert*. Manual, dashboard-only, account-wide, and
  informational: they email on projected spend and cap nothing.
- The enforced ceiling lives in the API Worker (`BUDGET_*` vars, D1
  `cost_ledger`, nightly cron). See [cost-guardrails.md](cost-guardrails.md) and
  ADR-0022.
- **Secret:** `CF_ANALYTICS_TOKEN` on `handsontable-demos-api` — a read-only
  token scoped to *Account → Account Analytics → Read*, used by the nightly
  reconciliation. Absent → the cron skips and estimates stand.
- **Cron trigger:** `17 4 * * *` on `handsontable-demos-api`.

## Provisioning notes

- Resources are managed with `wrangler` (authenticated as
  `mateusz.wojczal@handsontable.com`), targeting the account via
  `CLOUDFLARE_ACCOUNT_ID=15111272c53ed0aaf84a908f0c9c7f8b`. The Cloudflare MCP
  connection is bound to the **sandbox** account, so it is **not** used for this
  project's resources.
- Deploy target: this account's `*.workers.dev` subdomain, which is a valid login
  broker return host (no per-app Google setup needed).
