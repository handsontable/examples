# Talk with the current example

The **Ask AI** panel in the playground answers questions about the example that
is open in the editor, and can propose edits to it (DEV-2047).

Answers are grounded in the Handsontable documentation and in the example's own
source, so "what does this do?" and "add a checkbox column" are both in scope,
and both answers are about *this* code rather than Handsontable in general.

## How it fits together

```
Browser (apps/authoring — Chat.tsx, docsSearch.ts)
 ├─ POST hot-docs-assistant…/api/search   → doc chunks + citations
 └─ POST demos.handsontable.com/api/chat  → question + example files + those chunks
       └─ Worker (workers/api — chat.ts)
            + Algolia page hits (DocSearch index `handsontable`)
            + the example's framework and pinned Handsontable version
            → LiteLLM /v1/chat/completions, forced tool call
       ← { message, edits[], references[], pages[] }
 └─ Apply → runtime.writeFile() → the running preview HMRs the change
```

### Why retrieval runs in the browser

The docs-assistant is deployed on `workers.dev`, and **Cloudflare blocks
Worker → workers.dev fetches with error 1042**, so `handsontable-demos-api`
cannot call `/api/search` at all. Its README says so explicitly and recommends
calling from a browser or a non-Cloudflare backend. Its CORS on that route
(`Access-Control-Allow-Origin: *`, no credentials accepted) makes the browser a
supported caller, so that is where retrieval lives.

If per-IP limits (40 req/60 s) ever bite, the fix is a service binding or a
caller token from the docs-assistant maintainer — not a workaround.

### Why there are two search sources

| | docs-assistant `/api/search` | Algolia `handsontable` |
|---|---|---|
| Returns | real content chunks | headings + URLs (`content` is usually null) |
| Latency | ~2–4 s (vector query) | ~50 ms |
| Used for | grounding the answer | "here's the page to read next" |

They are complementary. Chunks are what stop the model inventing API surface;
Algolia is what gives the user somewhere to go afterwards.

Both are deduped and filtered to the example's framework flavour
(`javascript` / `react` / `vue` / `angular`) — the knowledge base and the index
each store every guide once per framework, so an unfiltered `topK` comes back
as near-copies of the same page.

## Safety

An assistant that can rewrite the file you are looking at needs more than good
intentions. The layers, in order:

1. **Input validation** (`chat.ts`) — 800 characters per message, 10 turns,
   caps on file count and total size, and a prompt-injection pattern list
   lifted from theme-builder.
2. **A forced tool call** — the model must answer through the `answer` tool, so
   every response has the same shape and free-form output never reaches the UI.
3. **Output whitelisting** — edit paths are re-validated as safe relative paths
   (no traversal, no `node_modules`, no lockfiles), contents are size-capped,
   HTML is stripped from the prose, and **citations must be `handsontable.com`
   URLs**. A fabricated link is the output a user is most likely to click.
4. **Nothing is applied automatically.** The panel shows which files would
   change; the user presses Apply, and one press of Undo restores the previous
   contents.
5. **Rate limiting** — 8 questions/minute and 120/day per IP, in KV. The route
   is public and every call costs money, so it needs a gate that reacts faster
   than the monthly ceiling can. `POST /api/chat/event` has its own, looser
   bucket (60/min, 600/day): it costs one counter row, and sharing the chat
   bucket would let Apply/Undo spend a user's question quota — or let anyone
   exhaust an IP's paid budget through the free route.
6. **The budget ceiling** — chat answers to the same tiers as containers
   (DEV-2030): sign-in required at the `anon_blocked` tier, refused at
   `new_blocked` and above.

The system prompt also tells the model that file contents and documentation
text are data, never instructions — the example being edited is itself
untrusted input.

## Cost

Each answer is metered into `cost_ledger` under the `llm` SKU, using the
`x-litellm-response-cost` header the gateway returns — a real figure rather
than an estimate. It counts toward the monthly ceiling like everything else.

Measured on the first real answers: **roughly $0.01 per question** (Sonnet, a
small example, ~5 doc chunks). The per-IP cap of 120/day therefore bounds one
abusive client at about **$1.20/day**, and the budget tiers bound everyone
together.

## Analytics

`/admin` has an **AI assistant** section (`{days}` window, same as the rest of
the panel):

| Shown | From |
|---|---|
| Questions asked | `chat_message`, per framework |
| Answers with code | `chat_edit` — share of answers that proposed an edit |
| **Edits applied** | `chat_edit_applied`, reported by the panel |
| Edits undone | `chat_edit_undone` |
| Spend + cost per answer | `llm` SKU in the cost ledger |
| Refused | `chat_denied`, split by `rate_limit` vs `budget` |
| Failures | `chat_error` — gateway unavailable or misconfigured |

**Edits applied is the number worth watching.** Questions asked only says the
button is discoverable; edits applied says the answers were good enough to
keep. Applied-then-undone is the sharper negative signal — the answer looked
right until it ran.

Whether an edit was accepted is only knowable in the browser, so the panel
reports it through `POST /api/chat/event` with the event name and framework —
fire-and-forget, nothing identifying, aggregated per day like every other
counter. Question text is never stored — only that a question was asked and
which framework it was about, and that framework is folded into a fixed label
set server-side so a public caller cannot invent new ones.

## Configuration

| Setting | Where | Notes |
|---|---|---|
| `LITELLM_API_BASE`, `LITELLM_MODEL` | `wrangler.jsonc` vars | Non-secret |
| `ALGOLIA_APP_ID`, `ALGOLIA_INDEX` | `wrangler.jsonc` vars | Public by construction |
| `LITELLM_API_KEY` | Worker secret | **Absent → `/api/chat` returns 503**, nothing else breaks |
| `ALGOLIA_API_KEY` | Worker secret | Absent → answers still work, without page links |
| `VITE_DOCS_SEARCH_URL` | authoring build | Defaults to the production docs-assistant |

```bash
cd runner/workers/api
npx wrangler secret put LITELLM_API_KEY     # LiteLLM virtual key
npx wrangler secret put ALGOLIA_API_KEY     # Algolia search-only key
```

Locally both go in `workers/api/.dev.vars` (gitignored). The repo's `.env` /
`.env.example` document the same values for scripts.

Every dependency degrades independently: no LiteLLM key disables only the chat
button's usefulness; no Algolia key drops the page links; a docs-assistant
outage produces an ungrounded answer rather than no answer.

## Reference implementations

- **theme-builder** (`netlify/edge-functions/chat.ts`) — the LiteLLM call
  shape, forced tool call, and the validate/sanitise layers this reuses.
- **docs-assistant** (`README.md#post-apisearch`) — the retrieval contract,
  including the Worker-to-Worker restriction above.
