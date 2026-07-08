# ADR-0008: Per-user demos + fork flow

**Status:** Accepted

## Context
Internal users need to build and share their own demos, starting from existing
ones.

## Decision
Each signed-in user owns demos in D1 (`created_by`). Creating a demo is a fork:
open any existing demo (catalog starter or a saved demo, recorded in
`forked_from`), edit live, set a **title + description**, save → unique `/d/:id`.
"My demos" = `GET /api/demos?mine=1` by `created_by`.

## Consequences
- D1 schema gains `description` and `forked_from` (+ index).
- Forks are independent; editing one never affects the source.
