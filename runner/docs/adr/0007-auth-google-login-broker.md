# ADR-0007: Auth via the Handsontable Google login broker

**Status:** Accepted (supersedes the original spec's Cloudflare Access)

## Context
Authoring is internal-team-only. The `publish-app` skill prescribes a shared
Google login broker (Handsontable accounts only, no passwords) for org apps.

## Decision
Gate authoring + all write endpoints behind the broker
(`https://mcp-auth-proxy-j0tb.onrender.com`). Frontend redirects to
`/broker/login?return_to=…`, receives a JWT, resolves identity via
`/broker/userinfo` (`@handsontable.com` only). The Worker re-validates the token
server-side and sets `created_by` from the verified email. Deploy on a
`*.workers.dev` host (an allowed return host).

## Consequences
- No per-app Google setup; no passwords; no service account.
- Replaces Cloudflare Access for this project.
