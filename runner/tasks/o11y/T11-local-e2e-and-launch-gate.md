# T11 — Local end-to-end verification and launch gate

| | |
|---|---|
| Status | todo |
| Size | M |
| Depends on | T00–T10, T12 |
| Blocks | merging `feat/runner-observability` to `master` |
| ADR | 0041 rev. 3 §L (exit criteria 1–15); ADR-0042; implementation deltas `T<nn>-D<k>` |
| Owns | `e2e/o11y-local.spec.ts` (gated `E2E_O11Y_LOCAL=1`), the final pass over `docs/run-and-deploy.md`, `runner/AGENTS.md`, `docs/adr/0041…0043`, `docs/adr/README.md`, and the deletion of `runner/tasks/o11y/` |

## Goal

Prove the whole stack on localhost with real traffic from the real app, decide whether
ADR-0041's exit criteria are met, write the launch plan, fold the deltas into the ADR,
and leave the branch with no temporary files.

## Scope

In:

- **Walkthrough** with every piece local: authoring (Vite, `VITE_TELEMETRY_LOCAL=1`), API
  worker, o11y worker, Grafana box. Scripted steps: open a Tier-1 and a Tier-2 example, type
  a keystroke ladder into the editor, save and share a demo, open its `/d` and `/embed`,
  switch versions, open a docs-guide example by `?docs=` and fork it (ADR-0042 events and
  attribution), replay the deploy and Sentry fixtures, force a handled and an uncaught
  error. Every dashboard panel from T09 shows this traffic (not seed data), the expected
  alerts reach the Slack capture server once, and nothing reaches Sentry that should not.
- **`e2e/o11y-local.spec.ts`**: the automatable part of the walkthrough, own port, gated.
- **Volume and cost projection**: lines and points per session and per request measured
  locally, times production traffic read from `usage_daily` (read-only), against the
  Workers Logs and export allotments and the o11y awake-hour model. This is an exit
  criterion.
- **Exit-criteria table**: each of ADR-0041 §L criteria 1–15 with its measured value,
  its threshold and its evidence (local run or sandbox probe). A failed 1, 2 or 7 after its
  plan B stops the launch (ADR §L).
- **Launch plan** in `docs/run-and-deploy.md`: runbook steps first, then o11y worker, API
  worker, authoring, all with Sentry scope `full`; a short production smoke of
  the facts the sandbox probes measured; the criteria for flipping `SENTRY_SCOPE` and
  `VITE_SENTRY_SCOPE` to `uncaught` (data seen end to end in Grafana, alerts firing once,
  volume inside the projection), and who flips them; rollback (drop the export
  destinations, revert the observability block; the scope flag needs no revert).
- **Fold and clean**: fold every `T<nn>-D<k>` delta from the task Outcomes into
  ADR-0041/0042/0043 and update the ADR index; set ADR-0041 to Accepted only
  when both criterion groups have evidence, and ADR-0042 to Accepted with it; leave ADR-0043
  Proposed as the record of T13, which runs after launch; update
  the AGENTS.md observability bullet from "proposed, not yet built" to what shipped; move
  anything worth keeping from task Outcomes into `docs/run-and-deploy.md` or the contract;
  then `git rm -r runner/tasks/o11y` in the final commit.

## Acceptance criteria

- Walkthrough checklist complete with evidence (links to screenshots, captured payloads,
  query results) in the PR description.
- `E2E_O11Y_LOCAL=1 pnpm e2e e2e/o11y-local.spec.ts` green, run raw.
- The projection shows exported events and Workers Logs events under half of the included
  allotments at current traffic, or the PR says it does not and proposes the fix.
- No file under `runner/tasks/` remains; `grep -rnE "tasks/o11y|task board|ADR-DELTAS"
  runner` finds nothing outside the folded ADR text.
- The PR into `master` uses the repository PR template.

## Traps

- A green e2e run against a stale authoring `dist` proves nothing; the root `pnpm build`
  builds packages only. Build the app you are testing.
- Use your own Playwright port; another worktree's server on 4173 is silently reused.

## Outcome

_Filled in when done._
