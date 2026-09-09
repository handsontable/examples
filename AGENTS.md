# AGENTS.md, handsontable/examples

This repository holds runnable Handsontable example projects (`examples/`,
`server-examples/`) and the self-hosted demo runner behind
demos.handsontable.com (`runner/`, see [`runner/AGENTS.md`](./runner/AGENTS.md)
for that subsystem specifically).

## Adding or changing an example

Follow [CONTRIBUTING.md](./CONTRIBUTING.md), in particular registering a new
example in `runner/config/frameworks.json` so it appears on the live demo
site. Skipping that step fails silently (no error, the example just never
shows up on demos.handsontable.com), so don't assume it's covered by CI
passing.

## Opening a pull request

Always fill in [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md),
including its Context, Types of changes, How was this verified, Checklist, and
Related issue(s) sections. Do not leave GitHub's default blank PR body, and do
not compose a PR description that skips the template. This applies equally to
PRs opened by an AI agent and PRs opened by a person.
