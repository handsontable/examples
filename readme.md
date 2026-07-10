# Handsontable Code examples

This folder contains all code examples that Handsontable uses for a myriad of
reasons, such as documentation, blog, etc. Each code example is a separate
project that uses Handsontable to present certain features.

Code examples are structured by Handsontable language or framework.

## Demo runner

The [`runner/`](./runner/) folder holds the self-hosted **demo runner** — the
system that renders every example (and every documentation-guide example) live at
any Handsontable version, lets internal team members edit the code on the fly, and
produces permanent client URLs to share. It replaces CodeSandbox and the old
`render-ms` redirect microservice (now removed).

See [`runner/README.md`](./runner/README.md) and
[`runner/docs/docs-examples.md`](./runner/docs/docs-examples.md) for details.
