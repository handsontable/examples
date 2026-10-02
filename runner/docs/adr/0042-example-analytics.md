# ADR-0042: Count which examples people open, by docs guide and starter

**Status:** Proposed — design approved 2026-09-23 (revision 2), implemented.
Ships with ADR-0041 and depends on its ingest path and Grafana; stays at the same status
(Proposed) until ADR-0041 flips to Accepted, for the same pending production
reading (see ADR-0041's own status line and Implementation deltas below).

## Context

Nobody can say which Handsontable features people reach for a live example of.
Opening an example on `/` — `?docs=<content-path>` for a documentation-guide example,
`?example=<starter>` for a starter — never reaches the API worker: the SPA and the
example JSON come from the assets worker, and `notePageView` counts only `/d`, `/embed`
and `/share`.

What already exists:

- **The taxonomy.** The docs-example JSON under
  `apps/authoring/public/docs-examples/<bucket>/` holds 1,482 entries across 130 guides,
  each with `guide`, `exampleId`, `docPermalink`, `breadcrumb` (its first element is the
  area: Columns, Rows, Formulas, Accessibility, Recipes…), `framework` and `lang`.
  Starters are the 19 keys of `config/frameworks.json`.
- **Attribution.** `demos.forked_from` already records each saved demo's origin
  lineage (`catalog:<framework>`, `mcp:<framework>`, and docs, import and payload
  prefixes), so saved demos and their `/d` and `/embed` views can be traced to an
  example without a migration. The implementing task confirms the exact docs format and
  the first date from which every save carries it (review: 2026-07-17). **Confirmed
  (from git history, not production data):** the docs format is
  `docs:<bucket>:<content-path>` (three segments), landed in commit `3277a52a4`,
  **2026-07-17 13:38:35 +0200** — before that commit, a docs save carried only the
  2-segment `docs:<content-path>` (no bucket), whose `ref` cannot be resolved back to a
  guide. This ADR's own §"No migration for attribution" rule uses this exact date as the
  cutoff for "unknown." No code in this repository performs the `forked_from` ↔ `/d`/
  `/embed`-view join this Context section describes — it is groundwork for ADR-0043, not
  a deliverable of this ADR.
- **No referrer.** The docs site's buttons use `rel="noopener noreferrer"` and the site
  sends `strict-origin-when-cross-origin`, so a docs deep link cannot be told apart from a
  direct visit by its referrer, and no embed request carries the docs page path.

Constraint: anonymous by construction. Counts only, no user id, no per-request rows.

## Decision

1. **`example.open`**, fired once per resolved example (not per render) at the
   example-resolve path in `App.tsx`, sent through the ADR-0041 facade and turned into an
   Analytics Engine point at ingest. It is **never written to the inbox or Loki**, so it
   carries no page-load id anywhere it is stored. Attributes: `kind` (`docs`, `starter`,
   `saved`, `import`, `payload`), `ref` (defined per `kind`, `exampleAnalytics.ts#exampleTaxonomy`:
   the docs guide path for `docs`; the starter's `config/frameworks.json` key for `starter`;
   the saved demo's id for `saved`; the import provider for `import`; the payload source for
   `payload`), `area` (the
   loaded entry's first breadcrumb element; it is not derivable from `ref`), `framework`
   (for docs examples this already distinguishes JavaScript from TypeScript), `ht_major`,
   `bucket`, and
   `entry` — `deep-link` when the example came from the URL at page load, `picker`,
   `switch`, `version-switch` or `fork` otherwise. `entry` is known inside the app, so it
   needs no referrer. **Implementation note:** distinguishing a post-fork landing
   from an ordinary deep link needs a one-shot URL marker (`?fork=1`, stripped on read via
   `history.replaceState`, never `localStorage`/`sessionStorage`), because `onFork`
   navigates with a full page reload — the same hard-navigation pattern the rest of the
   app already uses for every route change, which destroys any in-memory alternative. A
   bare `/` with no `?example=`/`?docs=` at page load (the silent starter default) is not
   counted as a `deep-link` open — that default is not the visitor reaching for anything.
2. **Engagement**, same shape and same storage rule: `example.engaged` (first code edit,
   or preview ready plus 30 s), `example.forked`, `example.saved`, `example.shared`,
   `example.downloaded`. Engaged opens rank features; raw opens rank curiosity.
   `example.saved` is the one the API worker writes, when an editor Save's rebuild
   succeeds, because the rebuild can take longer than the visitor stays on the page. The
   editor passes the open example's `ht_major` in the Save request, so the row has the
   same values the browser would have sent (contract §5).
   **Design change (DEV-3146):** a save is attributed to its *source example*, not to the
   demo. The funnel panel filters `blob17='docs'` and a saved demo's own taxonomy is
   `kind=saved, ref=<demo id>`, so saves never showed. The API worker now resolves the row's
   `forked_from` (following saved-demo hops, capped at 5) to the example's `kind`/`ref`/`area`/
   `bucket`. `area` is not derivable from the lineage, so the worker bundles a compact
   `docsPath` → `[guide, area]` map, `workers/api/src/docs-taxonomy.generated.ts`,
   regenerated from the docs-examples manifests by the import-docs workflow and pinned by a
   freshness test. A rollup-side lineage join was rejected: the funnel reads Analytics
   Engine, not D1. Unresolvable lineages (MCP demos, unknown docs paths) stay
   `kind=saved, ref=<demo id>`. Saves counted before this change keep that shape.
   The taxonomy resolves per bucket (the lineage's own, newest for the legacy bucket-less
   form), and the lineage reads run inside the `waitUntil` chain after the D1 update, so they
   cannot delay or cancel a save. The funnel's "saved" stage counts Save actions on any
   descendant of an example (repeat saves, saves of a fork's fork), while `engaged`, `shared`,
   `forked` and `downloaded` fired from a reopened saved demo still go out as `kind=saved`; so
   per area `saved` can exceed `forked`, and the stage is not a strict narrowing of the one
   before it.
   `serve.share` still undercounts edge-cached views; a server-side share route does not
   exist, so there is nothing to count on yet.
3. **No migration for attribution**: rollups join `demos.forked_from` against `/d` and
   `/embed` view counts; demos saved before the confirmed date are reported as `unknown`.
4. **Analytics Engine layout**: `kind`, `ref` and `area` take three of the blob slots the
   observability contract left unassigned (`blob17`–`blob19`); one stays free.
   **Implementation note:** these three keys, and ADR-0041 §F's own AE-only
   `bucket`/`reason`/`fingerprint` keys, share one transport problem — none has a dotted
   `hot.*` resource-attribute form, so the browser's own scrub allowlist silently dropped
   them before this was found and fixed (ADR-0041 §M). `kind` is read from
   `hot.metric_kind`, not `hot.kind`, which is reserved for the Faro item's own kind.
5. **Permanent record**: a nightly step in the reconcile cron recomputes **the previous
   full UTC day** from Analytics Engine into D1 `example_daily(day, kind, ref, area,
   framework, ht_major, opens, engaged, forked, saved, shared, downloaded)` with primary
   key `(day, kind, ref, framework, ht_major)` (`area` is a function of `ref`), written
   with `INSERT OR REPLACE`. Re-running it for a day replaces that day's rows; events
   arriving after the day closed are not counted. Counts use
   `SUM(_sample_interval * count)`. **Follow-up:** `example_daily` shipped
   without a `downloaded` column — this decision's own six-metric list above
   included `example.downloaded`, but the table and rollup only ever carried the other
   five. Migration `0009_example_daily_downloaded.sql` (additive `ALTER TABLE ... ADD
   COLUMN downloaded INTEGER NOT NULL DEFAULT 0`) and the matching `reconcile.ts` rollup
   change close that gap; existing rows backfill to `downloaded = 0` (their true count for
   already-rolled days is unrecoverable from D1 alone, and 0 never overcounts).
   **Follow-up (DEV-3146):** D1 meters every statement of a `batch()` against its
   per-invocation query limit (1000 on Workers Paid, documented 2026-10-01) and caps bound
   parameters at 100 per statement, so one `INSERT` per row would exhaust it on a large day.
   Rows now go in as multi-row `INSERT`s of 8 (12 columns, 96 parameters) in the same single
   batch as the `DELETE`, and a day needing more than 500 statements (about 4,000 rows) throws
   before the `DELETE`, so the previous run's rows survive and Sentry gets the failure.
   Splitting into several batches was rejected: it saves no queries and a failure between
   batches would persist a half-written day.
6. **Dashboard** "Examples & features" reads Analytics Engine, so it covers the last three
   months without D1: top guides by opens and engaged opens, area breakdown, framework
   split per guide, starter ranking, `ht_major` distribution, the funnel open → engaged →
   saved → shared per area, deep-link share of opens, zero-open examples over 90 days. A
   long-range view from `example_daily` waits for ADR-0043's D1 path. **Not implemented:**
   the zero-open-examples-over-90-days panel — Analytics Engine only ever holds
   points for events that happened, so a "never happened" query needs the full docs-example
   taxonomy (every guide × framework that exists, from the docs-examples JSON, not from
   `runner_events` or D1) to diff against; the other seven panels shipped.

## Consequences

- One event family, one D1 table, one nightly rollup step, one dashboard. No `demos`
  migration.
- The data measures who reached for a live example, not who read the docs page; pair it
  with the docs site's analytics before calling a feature important.
- Docs pages are not attributed to embed views, and deep links are counted by how the app
  was entered, not by where the visitor came from.
- Tests: an `example.open` test that drives the real resolve path, a test that
  `example.*` never reaches the inbox, and an idempotency test for the rollup.
