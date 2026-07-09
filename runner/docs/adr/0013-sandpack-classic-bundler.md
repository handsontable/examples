# ADR-0013: Sandpack classic in-browser bundler for Tier 1

**Status:** Accepted

## Context
Tier 1 must bundle in the browser with no server. Sandpack offers a classic
(browser) bundler and newer Nodebox-based templates — the latter are forbidden
(ADR-0003).

## Decision
Use `@codesandbox/sandpack-client` with **classic-bundler environments only**
(`parcel`, `create-react-app[-typescript]`, `vue-cli`). Phase 1 uses Sandpack's
hosted bundler; Phase 2 (optional) self-hosts the classic bundler and sets
`bundlerURL`. White-label: `showOpenInCodeSandbox:false`, no CodeSandbox marks.

## Consequences
- Zero server cost for Tier 1; edits recompile in tens of ms.
- Bundler-environment mapping per framework lives in `config/frameworks.json`.
