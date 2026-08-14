# ADR-0033: A separate service auth for headless demo creation from the MCP

**Status:** Accepted (DEV-2501, subtask of DEV-2498)

## Context

Someone should be able to describe a demo to Claude and get back a working
`demos.handsontable.com` link, owned by them, without touching the browser. The
Handsontable MCP (`hot-mcp`) is where that call would come from: it already knows who
the caller is, because the auth proxy forwards the verified Google email and hot-mcp
lifts it onto the tool session (its ADR-0043).

Most of what that needs already exists here and must not be rebuilt. `POST /api/demos`
snapshots the files, runs the real framework build in the builder container, writes R2 +
D1 and mints `/d/:id`; `created_by` comes from the authenticated identity, so "My demos"
and the `PATCH`/`DELETE` ownership checks work with no new user model.

The open question was only **how a service authenticates**. Two options:

1. **Reuse the broker login path.** `authenticate()` trusts the address the broker returns
   for a caller's token, so an integration able to obtain such a token would be accepted
   here as an ordinary login. Zero changes on this side.
2. **A scoped service path**, separate from the auth that guards every existing write.

Option 1 is tempting precisely because it costs nothing here. It was rejected on the
principle rather than the plumbing: it would give this integration the **broker's own
authority** — the ability to present itself as a team member — where all it needs is the
ability to create a demo. It would also widen the set of places that depend on the broker's
credential, so a problem there would reach past this runner. A narrow capability is the
right price for a narrow feature.

## Decision

**A separate, minimal service path — `POST /api/mcp/demos`, authenticated by
`authenticateService()`.**

- **Two headers, both required.** `X-MCP-Secret` must equal the `MCP_SHARED_SECRET`
  Worker secret (compared in a length-independent loop, so a wrong value cannot be probed
  byte by byte), and `X-Demo-Author` must be an `@handsontable.com` address. The secret
  says *a service we provisioned* is calling; the address says *whose demo this becomes*.
  hot-mcp fills the address from its own verified session — never from a user's prompt.
- **Fails closed.** With `MCP_SHARED_SECRET` unset the path 401s for everyone, so a Worker
  deployed without the secret has no service path rather than an open one. The secret lives
  in Worker secrets, never in git.
- **The broker path is untouched.** `authenticate()` keeps guarding `/api/demos`,
  `PATCH`, `DELETE`, sessions and chat exactly as before. Nothing about this widens it.
- **Agent-supplied files are re-validated** (`mcp-create.ts`). The browser paths inherit
  their guarantees from the FILES panel, which is text-only by ADR-0031; a service request
  has no such history, so the same rules are re-established at the edge: absolute paths, no
  traversal, text contents, **`.env*` refused anywhere**, build/vendor dirs and lockfiles
  refused, `/package.json` required, and caps of 50 files / 256 KB. Offending payloads are
  **refused, not filtered** — quietly dropping files would build something the caller did
  not write.
- **A description is required on this path**, though the editor treats it as optional. A
  demo created from a prompt is read by people who were not in that conversation.
- **Ownership comparisons fold case; the broker's address is left alone.** `created_by` is
  compared as a string, so the service path normalising an address while the broker path did
  not would hide a mixed-case owner's demo from their own "My demos" and refuse their own
  edit. The fix is `sameOwner()` plus `LOWER(created_by)` in the listing query — **not**
  rewriting what the broker path returns: that value is also the key `profiles` reads, so
  normalising it would lose someone's saved display name and avatar and let the next save
  write a duplicate row. Comparing loosely is cheap; changing an identity other subsystems
  already key on is not.
- **Same build, same ceiling.** The route calls the existing `createDemo()` behind the same
  `budgetGate` and `recordUsageEvent` as any other build, and stamps
  `forkedFrom: "mcp:<framework>"` so MCP-created demos are identifiable in D1.

## Consequences

A demo can be created end-to-end from a prompt, owned by the person who asked, appearing in
their "My demos" with `/d/:id`, `/edit/:id`, `/share/:id` and `/embed/:id` links — and the
credential that makes it possible can do nothing except create demos as a named team member.

**Trade-offs and follow-ups:**

- A shared secret is a bearer credential: whoever holds it can create demos as any team
  member. That is bounded — create-only, team-only, budget-gated, and attributable through
  `forkedFrom` — but it is not per-user cryptographic proof. Rotating it is
  `wrangler secret put MCP_SHARED_SECRET` plus the matching value on the calling service.
- There is no rate limit beyond the existing budget tiers. A misbehaving agent loop would
  show up as build spend, which is what the ceiling is for — but a per-author cap on this
  path is the obvious next guard if that ever happens.
- The caps make this path unsuitable for uploading a real project. That is deliberate: the
  ticketed-upload flow in DEV-2501 is the answer for local folders, and it can reuse
  `authenticateService()` unchanged.
- `update_demo` / `delete_demo` from the MCP are not part of this decision. They would need
  the service path to assert ownership the way the broker path does, and nothing needs them
  yet.
