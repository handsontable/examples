# ADR-0016: CodeMirror 6 as the code editor

**Status:** Accepted

## Context
The shell needs an embeddable code editor (spec allowed CodeMirror or Monaco).

## Decision
Use CodeMirror 6 via `@uiw/react-codemirror` — lighter than Monaco, embeds
cleanly, good language support. Re-key the editor on active-file change so buffers
swap correctly.

## Consequences
- Smaller bundle; simpler embedding than Monaco.
- Language modes added per file extension (js/ts/tsx/json/html/css/vue).
