# ADR-0010: Deploy to the main Handsontable Cloudflare account

**Status:** Accepted

## Context
The `publish-app` skill defaults to the sandbox account, but this is a production
tool. The team directed all resources to the main Handsontable account.

## Decision
Provision and deploy in the main Handsontable account. Manage resources with
`wrangler` (authenticated as the maintainer). The Cloudflare MCP connection is
bound to the sandbox account, so it is **not** used for this project's resources.

## Consequences
- D1/KV/R2 created in the main account; config in `workers/api/wrangler.jsonc`.
- Provisioning steps are scripted via wrangler, not the MCP.
