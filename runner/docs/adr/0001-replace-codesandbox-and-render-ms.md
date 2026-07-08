# ADR-0001: Replace CodeSandbox + render-ms with a self-hosted runner

**Status:** Accepted

## Context
Live framework demos were served via CodeSandbox, dispatched by the `render-ms`
microservice (redirects to CodeSandbox with a Handsontable version from query
params). CodeSandbox became too expensive, and per-view cost scales with traffic.

## Decision
Build a self-hosted system that (a) renders every example live at any Handsontable
version, (b) lets internal team members edit code on the fly, and (c) produces a
clean, permanent client URL to share. Retire `render-ms` afterwards.

## Consequences
- We own rendering, editing, and sharing; no CodeSandbox runtime dependency.
- Requires an in-browser bundler (Tier 1) and a container runtime (Tier 2).
- Cost shifts to bounded internal authoring compute; client views cost nothing.
