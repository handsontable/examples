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

## Provisioning notes

- Resources are managed with `wrangler` (authenticated as
  `mateusz.wojczal@handsontable.com`), targeting the account via
  `CLOUDFLARE_ACCOUNT_ID=15111272c53ed0aaf84a908f0c9c7f8b`. The Cloudflare MCP
  connection is bound to the **sandbox** account, so it is **not** used for this
  project's resources.
- Deploy target: this account's `*.workers.dev` subdomain, which is a valid login
  broker return host (no per-app Google setup needed).
