# ADR-0009: Docs-only embeddable URL (frame-ancestors)

**Status:** Accepted

## Context
Demos must be embeddable on docs pages (e.g.
`handsontable.com/docs/.../recipes/themes/ant-design/`) and only there.

## Decision
Serve `GET /embed/:id` (read-only, prebuilt-static) with
`Content-Security-Policy: frame-ancestors https://handsontable.com
https://*.handsontable.com http://localhost:*`, plus `Sec-Fetch`/Origin checks as
defense in depth. `frame-ancestors` is the authoritative cross-origin control.
**Generating/copying** the embed URL is shown only to signed-in internal users;
**serving** it is public but frame-locked.

## Consequences
- No third-party site can embed a demo.
- `/d/:id` (direct client link) stays framable-nowhere; `/embed/:id` is the docs
  variant.
