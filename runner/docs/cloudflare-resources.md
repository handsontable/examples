# Cloudflare resources

What the runner needs provisioned, and how the pieces bind together. Concrete
account, database and namespace ids are **not** kept here — they live in the
deploying environment (`.env`, CI secrets, `wrangler.jsonc`). `wrangler whoami`
prints the account you are authenticated against.

All resources live in the main Handsontable Cloudflare account, not the sandbox.

## Bindings

| Kind | Name | Binding | Notes |
|------|------|---------|-------|
| D1 | `handsontable-demos` | `DB` | region EEUR; schema `migrations/0001_init.sql` applied |
| KV | `handsontable-demos-cache` | `CACHE` | edge read-cache for demo JSON |
| R2 | `handsontable-demos` | `ARTIFACTS` | built static demos |

Create them with `wrangler d1 create`, `wrangler kv namespace create` and
`wrangler r2 bucket create`; each command prints the id that goes into
`workers/api/wrangler.jsonc` and `.env`.

## Deployment

Two Workers:

- **API / orchestration:** `handsontable-demos-api` — sessions, `/api/demos`,
  `/d/:id`, `/embed/:id`, the build snapshotter, `/api/chat`. Owns the D1, KV and
  R2 bindings and the nightly cron.
- **Authoring app:** `handsontable-demos-authoring` — the static SPA, served as
  Workers Assets. Gated by the Handsontable login broker (ADR-0007).

Both are served from **https://demos.handsontable.com**; each also keeps its
account `*.workers.dev` URL, which is a valid login-broker return host.

**7 container applications** back the Tier-2 live sessions (Sandbox SDK), one per
meta-framework — remix, angular, next, next-shadcn, astro, nuxt — plus a
`buildersandbox` that runs the static build snapshotter.

Deploy with `npx wrangler deploy` from `workers/api/` and `apps/authoring/`, or
let the `deploy-runner-*` workflows do it on merge to `master`. See
[run-and-deploy.md](run-and-deploy.md).

### Preview URLs need a wildcard domain

Live Tier-2 sessions hand the browser a per-container preview URL of the shape
`<port>-<sandboxId>-<token>.demos.handsontable.com`, so the wildcard
`*.demos.handsontable.com` must route to the API Worker (ADR-0011). `*.workers.dev`
does not support wildcards — without the custom domain, static shares still work
(they are built in the builder container and served from R2) but live Tier-2
preview does not.

## Cost guardrails

Spend is metered per session into the D1 `cost_ledger` and reconciled nightly by
a cron on the API Worker. The ceiling and its degradation tiers are configured
through `BUDGET_*` vars and editable at runtime in `/admin`; the arithmetic behind
them is in [cost-guardrails.md](cost-guardrails.md) and ADR-0022.

The reconciliation job reads Cloudflare's own usage numbers through a **read-only**
API token scoped to *Account → Account Analytics → Read*, stored as a Worker
secret. Without it the cron skips and the runner's own estimates stand.

Cloudflare account-level **budget alerts** are configured in the dashboard
(Manage Account → Billing → Billable Usage → Set Budget Alert). They are
account-wide, informational, and cap nothing — they email on projected spend.
The enforced ceiling is the one in the Worker.

## Provisioning notes

- Resources are managed with `wrangler`, targeting the account via
  `CLOUDFLARE_ACCOUNT_ID`. The Cloudflare MCP connection is bound to the
  **sandbox** account, so it is deliberately not used for these resources.
- Deploy target: the account's own `*.workers.dev` subdomain plus the
  `demos.handsontable.com` custom domain and its wildcard.
