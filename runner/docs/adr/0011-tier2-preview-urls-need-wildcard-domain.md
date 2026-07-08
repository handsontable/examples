# ADR-0011: Tier-2 preview URLs need a wildcard custom domain

**Status:** Accepted

## Context
Cloudflare Sandbox preview URLs are subdomains
(`<port>-<id>-<token>.<domain>`). `.workers.dev` does not support preview-URL
subdomains; local `wrangler dev` works via `*.localhost` + Dockerfile `EXPOSE`.

## Decision
In production, route a wildcard custom domain (e.g. `*.demos.handsontable.com`) to
the Worker so `proxyToSandbox` can serve preview URLs (HTTP + HMR WebSocket).
Prove Tier-2 locally with `wrangler dev` before requiring the domain.

## Consequences
- Production Tier-2 depends on a wildcard DNS record + Docker at build time.
- The `/embed` and `/d` (static) paths do not need this; only live Tier-2 sessions.
