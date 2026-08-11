# ADR-0001: Replace CodeSandbox + render-ms with a self-hosted runner

**Status:** Accepted — `render-ms` is now removed (see ADR-0019); CodeSandbox is
no longer a runtime dependency.

## Context
Live framework demos were served by a third-party sandbox service, dispatched by
the `render-ms` microservice (redirects to it with a Handsontable version from
query params). Two problems: per-view cost scaled with traffic rather than with
authoring, and the rendering, editing and branding were all outside our control.

## Decision
Build a self-hosted system that (a) renders every example live at any Handsontable
version, (b) lets an author edit code on the fly, and (c) produces a clean,
permanent URL to share. Retire `render-ms` afterwards.

## Consequences
- We own rendering, editing, and sharing; no CodeSandbox runtime dependency.
- Requires an in-browser bundler (Tier 1) and a container runtime (Tier 2).
- Cost shifts to bounded internal authoring compute; client views cost nothing.
