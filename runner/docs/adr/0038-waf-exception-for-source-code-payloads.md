# ADR-0038: Source-code payloads need a WAF exception, not an encoding trick

**Status:** Accepted (DEV-2631)

> Numbered 0038, not 0035: 0035-0037 landed on master while this was in review.

## Context

On 2026-08-26 Aleksandra reported that **Fork** on demos.handsontable.com answers
403 while she is logged in. The button only exists when logged in, so the obvious
reading — a broken login — was wrong: `POST /api/demos` never returns 403 at all.
It returns 401, 400, or a budget-gate refusal. The 403 body was not ours either;
it was Cloudflare's "Attention Required!" interstitial.

The trigger is the request body. Reproduced against production, unauthenticated,
so the WAF verdict is isolated from our own auth (a body that reaches the Worker
answers 401; a blocked one answers 403):

| body | status |
|------|--------|
| `{"a":"b"}` | 401 — reaches the Worker |
| the full `base-web` starter workspace | **403** — Cloudflare |
| that workspace minus `/index.html` | 401 |
| `{"files":{"/index.html":"<script></script>"}}` | **403** |

The match is the literal `<script`, and nothing else we tried. `innerHTML =`,
`<img src=x onerror=alert(1)>`, `<svg onload=…>`, `javascript:`, `document.write`,
`eval`, `UNION SELECT` — all pass. It is one rule, not a category:

- ruleset `efb7b8c949ac4650a09736fc376e9aee` — the Cloudflare Managed Ruleset
- rule `9c8dda9708cc4452ac76e7be7b58420b`, action **block**

It fires zone-wide on handsontable.com — every hostname, every path, GET query
strings included — so nothing about the runner's configuration invited it.

**Why this looked like it "used to work".** It did. Forks of `javascript`
(2026-08-14) and `blank` (2026-08-17) are in the `demos` table, and both starters
carry `<script>`. WAF events for 2026-08-24 and 2026-08-25 show **zero** blocks on
demos.handsontable.com beyond bot scans of `/.env` and `/.git/config`; the 08-26
window has 56. This is a managed-ruleset change on Cloudflare's side
(`ruleset_version` 384, rule `version` 254), not one of our deploys.

**Why it is much bigger than Fork.** Every endpoint that carries a workspace is
affected, because 16 of the 19 frameworks in `config/frameworks.json` ship an
HTML entry with a `<script type="module">` tag — only `angular`, `next.js` and
`next-shadcn.js` are clean, and they are clean by accident (their toolchain
generates the tag). On the first day alone:

- `POST /api/session` — 28 blocks from ~25 distinct external IPs. This is the
  worst of it: those are visitors booting Tier-2 demos and docs embeds, not
  internal users, and they see a dead preview with no explanation.
- `POST /api/demos` — Fork and Embed, 16 blocks.
- `PATCH /api/demos/:id` — Save, so an editor session ends in a lost edit.
- `POST /api/payload` — the Theme Builder's generated project.
- `POST /api/mcp/demos` and `PATCH /api/mcp/demos/:id` — headless creation
  (ADR-0033), blocked twice from the MCP's own address.

## Decision

**1. Fix it at the edge, with a WAF exception.** A skip rule in the
`http_request_firewall_managed` phase on zone handsontable.com, skipping *only*
rule `9c8dda9708cc4452ac76e7be7b58420b` of the Cloudflare Managed Ruleset, scoped
to:

```
http.host eq "demos.handsontable.com" and starts_with(http.request.uri.path, "/api/")
```

Narrow on purpose, in all three dimensions. One rule rather than the ruleset, so
every other managed rule keeps guarding these endpoints. One hostname, so the
marketing site and docs are untouched. `/api/*` rather than the whole host, so
`/d/:id` and `/embed/:id` — the paths that actually *serve* HTML to a browser —
stay behind the full ruleset.

This is a false positive in the strict sense: the rule looks for a script tag
smuggled into a request as an injection attempt, and here a script tag in the
body is the payload's whole point. `/api/*` on this host accepts source code by
definition. Nothing downstream of it reflects that body into an HTML response —
files go to R2 and D1, and a built demo is served from `/d/:id` under
`frame-ancestors 'self'` — so the rule is protecting an attack surface the runner
does not have.

**2. Do not encode our way around it.** The obvious workaround does not work, and
the failed attempt is worth recording so nobody spends a day on it:

| attempted evasion | status |
|-------------------|--------|
| `"PHNjcmlwdD48L3NjcmlwdD4="` (base64) | **403** |
| `"<script>"` (JSON escape) | **403** |

Cloudflare's managed rules apply base64 and unicode-escape transformations before
matching, so both are seen through. Only breaking the token across a JSON
concatenation slipped past, which is not a wire format anyone should ship.

A gzip envelope *would* evade it — deflate bytes are not one of the decodings the
WAF applies — and was rejected anyway. It buys a fragile advantage against the
next transformation Cloudflare adds, in exchange for a wire-format migration
across `apps/authoring`, `workers/api`, the Handsontable MCP and the Theme
Builder, two of which we do not deploy. Fighting a false positive with obfuscation
also loses the argument permanently: the exception is a claim we can defend, and a
`Content-Encoding` trick is one we cannot.

**3. The `/api/session` blocks are the incident, not the Fork button.** Whoever
picks up the next report of a dead Tier-2 preview should check WAF events before
the container logs. `POST /api/session` carries `files`, so it fails at the edge
for the same 16 frameworks, and the runner never sees the request — no Sentry
event, no usage row, nothing in `wrangler tail`. The absence of evidence in our
own telemetry is the signature of an edge block, not of a healthy system.

**4. Both client paths must be able to say "this was refused above us".** An edge
block is undiagnosable from the inside otherwise, and until DEV-2631 both paths
described it wrongly — with increasing confidence, which is the worse direction:

- `POST /api/session` produced `session start failed (403): <!DOCTYPE html>…`. That
  trips the container-engine heuristic in `describeRuntimeError`, which replaces it
  with the local-dev "install Docker, run the API worker" text — the Sentry DEMOS-9
  misattribution (DEV-2538) reproduced for a new cause, and this time hitting every
  visitor of an affected framework at once. `sessionStartMessage` gains an edge tier
  phrased to miss that heuristic, dropping the Cloudflare markup instead of
  interpolating it, and deliberately offering no "Restart preview": a rule that
  refused this request will refuse the retry.
- Fork, Save and Embed reached `describeApiFailure`, whose 403 branch (DEV-2534)
  defaults to the ownership sentence. So a WAF block told owners **"This demo belongs
  to someone else — only its owner can change it."** and filed a reportable Sentry
  issue asserting it. A wire-string 403 at least looked like a bug; a fluent, specific
  and wrong sentence gets believed. The branch now classifies a 403 carrying **no
  `error` code at all** as `edge-blocked`, which is sound because every 403 the Worker
  sends has one — `forbidden` from the ownership checks, `token_forbidden` from the
  capability fence (ADR-0037).

The edge verdict stays reportable, and that is the point rather than an oversight:
the Worker never runs, so this client-side report is the only telemetry an edge block
produces anywhere.

## Consequences

Requests to `demos.handsontable.com/api/*` are no longer screened by that one
rule. Everything else in the managed ruleset still applies to them, and the
endpoints keep their own gates: `authenticate()` on the write paths,
`validateFiles`/`validatePayloadFiles` ceilings, the rate limiter on
`/api/payload`, and `budgetGate` in front of anything that boots a container.

The exception is invisible from the repo, which is the real cost — a checkout
gives no hint that production depends on a dashboard setting. Two mitigations:
this ADR, and the fact that the failure mode is loud and specific once you know
the shape (403 with a Cloudflare HTML body, nothing in our logs).

What is *not* fixed is the class. Another managed-rule change can break another
endpoint the same way, and it will again look like an application bug. The
diagnostic that settles it in one command:

```bash
# A body the Worker would refuse: 401 means the request arrived, 403 means the edge ate it.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://demos.handsontable.com/api/demos \
  -H 'Content-Type: application/json' \
  --data '{"files":{"/index.html":"<script></script>"}}'
```
