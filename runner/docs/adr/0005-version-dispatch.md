# ADR-0005: Handsontable version dispatch (lockstep, majors 15–19)

**Status:** Accepted

## Context
Demos must render at any chosen Handsontable version. The old `render-ms`
rewrote every dependency whose name contains `handsontable` (except
`@handsontable/pikaday`) to the requested version.

## Decision
Port that logic to `applyHandsontableVersion(files, version)`: pin core
`handsontable` and its framework wrapper in lockstep; never touch
`@handsontable/pikaday` (upstream `pikaday`, which docs examples migrate to,
falls outside the rule anyway). Accept semver (incl. npm partials), a bare pkg.pr.new id,
or a `pkg.pr.new` URL. Cap major at `HANDSONTABLE_MAX_MAJOR` (default 19).
Supported wrapper range: majors 15–19 (pre-15 used different wrapper package
names — out of scope).

## Consequences
- Amended by ADR-0036: this ADR defines what a version *is*; the API — not only
  the browser — is what applies it, and a missing one is derived from the
  payload rather than defaulted to a dist-tag.
- Same accepted inputs as the old deep links.
- Non-default versions in Tier 2 require a container `npm install` delta.
