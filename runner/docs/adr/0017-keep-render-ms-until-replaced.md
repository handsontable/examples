# ADR-0017: Keep render-ms running; compat shim; remove later

**Status:** Accepted

## Context
`render-ms` still serves live demos and is depended on until the new system fully
takes over.

## Decision
Do not delete `render-ms` in this work. Add a compatibility shim mapping old
`render-ms` deep links (`example-dir`, `handsontable-version`,
`handsontable-branch`, `handsontable-sha`, `example-branch`) to the new viewer.
Removal is a follow-up PR once the new system fully replaces it.

## Consequences
- No regression for existing links during migration.
- API-parity differences are reconciled before `render-ms` retirement.
