# T00 — Telemetry contract module, o11y scaffolds, dependencies

| | |
|---|---|
| Status | done |
| Size | M |
| Depends on | — |
| Blocks | T02–T09 (T01 may run in parallel) |
| ADR | 0041 rev. 3 §B.2, §C.2, §E.4, §F.1–§F.2; [observability contract](../../docs/observability-contract.md) |
| Owns | `packages/runtime/src/telemetry/**`, `packages/runtime/package.json` (exports), `workers/o11y/{package.json,tsconfig.json,wrangler.jsonc,src/index.ts,src/env.ts}`, dependency entries in every `package.json`, `pnpm-lock.yaml`, `workers/api/src/analytics.ts` (import re-point only), `pipeline/telemetry-*.test.mjs` |

## Goal

Turn the contract document into one importable module and one scaffolded Worker, and
add every new dependency once, so wave-1 agents code against the same names and never
fight over the lockfile.

## Read first

- `docs/observability-contract.md` — all of it; this task implements §3–§10.
- `packages/runtime/src/monitor.ts` — `normalizeMonitorMessage`, `redactPreviewHosts`,
  the no-DOM/no-Cloudflare rule the new module follows.
- `workers/api/src/analytics.ts:14-40` — `BOT_RE`, `deviceOf`, `browserOf`, `osOf`.
- `workers/api/src/monitor-inject.ts` — how a Worker imports a runtime subpath.

## Scope

In:

- `packages/runtime/src/telemetry/` with an `index.ts` barrel and one file per concern:
  - `attrs.ts` — attribute keys, allowed values, `service.name` values, the Loki label list.
  - `metrics.ts` — the §5 registry (name, emitters, used slots, allowed outcomes);
    `toAePoint(metric, values, attrs)` returning `{ indexes, blobs, doubles }` in the §4
    positional layout; `AE_COLUMNS` (column name → `blobN`/`doubleN`) for SQL builders;
    validation that rejects an outcome not listed for the metric.
  - `fingerprint.ts` — §7, including the demo-runtime ladder collapse.
  - `scrub.ts` — `scrubTelemetry(record)` per ADR §E.4, usable on Faro items in the
    browser and on normalised OTLP records at ingest (structural types only; no Faro
    import): strip query strings and fragments from every URL-valued field,
    `redactPreviewHosts` on every string, reduce browser meta to the device and browser
    classes, drop `user` meta, drop console items, drop the forbidden attributes of
    contract §3, and `stripCodeFrame` — an explicit remover of Babel's gutter-numbered
    source lines and caret markers, because `normalizeMonitorMessage` keeps them.
  - `classify.ts` — `BOT_RE` and the device/browser classifiers, **moved** from
    `workers/api/src/analytics.ts`, which now imports them (no behaviour change there).
  - `inbox.ts` — §8: OTLP `ResourceLogs` builders for one record, NDJSON encode/decode,
    `inboxKey(tenant, date, seq)` / `parseInboxKey()`, the key-state and storage-key
    types, the clean-marker key.
  - `lite.ts` — §9 payload type and a validator enforcing the size caps.
  - `sink.ts` — `AeSink` interface with `bindingSink(dataset)`, `clickhouseSink(url)`
    (local, §10), `memorySink()` (tests).
  - `facade.ts` — the §6 browser `Telemetry` interface (with `pageLoadId()`),
    `noopTelemetry`, `recordingTelemetry` (tests). No Faro import; T06 implements it.
  - `convert.ts` — Faro item → OTLP log record and beacon → OTLP log record (contract §6,
    §9), with the timestamp clamp, so T02 and T08 share one converter.
- `packages/runtime/package.json`: `"./telemetry"` subpath export with `types` and `default`.
- `workers/o11y/` scaffold: `package.json` (scripts `dev`, `typecheck`, `deploy` with the
  §1 `--routes` flags), `tsconfig.json`, `wrangler.jsonc` declaring **every** binding and
  var name from contract §2 (DO classes and migrations, R2 with EU jurisdiction, AE
  dataset, service binding, `observability` for the o11y worker itself per ADR §B.4),
  `src/env.ts` typing them, `src/index.ts` answering `501` on every contract route,
  `workers_dev: false` and `preview_urls: false`. API worker scaffold additions:
  `RUNNER_EVENTS`, the `O11Y` binding, the `SENTRY_SCOPE` var (values only; T05 wires them).
- Dependencies, each verified on npm at the time of the task and pinned exactly:
  `@grafana/faro-web-sdk` (authoring), `@cloudflare/containers`, `jose`, `source-map-js`
  and an OTLP protobuf decoder small enough for a Worker (compare candidates and record
  the bundle size) for the o11y worker, `wrangler` and `@cloudflare/workers-types` there,
  `acorn` as a pipeline devDependency if not already present. Record the chosen versions in the Outcome.

Out: any runtime behaviour — no Faro init, no route logic, no container.

## Acceptance criteria

- `import { toAePoint, scrubTelemetry, fingerprint } from "@handsontable/demo-runtime/telemetry"`
  typechecks in `workers/api`, `workers/o11y` and `apps/authoring`.
- `pipeline/telemetry-contract.test.mjs` parses the §3, §4 and §5 tables of
  `docs/observability-contract.md` and asserts the module matches them slot for slot and
  outcome for outcome; editing either side alone fails the test.
- `pipeline/scrub-telemetry.test.mjs` has one case per scrub rule, each built from a
  realistic input (a real Babel error with its code frame, a real preview-host URL, a real
  user-agent string, an OTLP record with `url.full` and geo), and each fails when its rule
  is removed.
- `pipeline/telemetry-convert.test.mjs`: converted records carry the contract resource
  attributes and a clamped event-time timestamp; converting the same item twice yields
  byte-identical output.
- `pipeline/telemetry-fingerprint.test.mjs`: a keystroke ladder (`t`, `tr`, `tru` is not
  defined) yields one fingerprint for `demo-runtime`; two genuinely different messages
  yield two; the value is identical when computed from the browser build and from Node.
- `analytics.ts` still passes its existing tests after the move.
- `cd workers/o11y && npx wrangler deploy --dry-run` succeeds.

## Verify

```bash
cd runner
pnpm install
pnpm --filter @handsontable/demo-runtime build
pnpm -r run typecheck
pnpm test
( cd workers/o11y && npx wrangler deploy --dry-run )
node scripts/check-test-presence.mjs feat/runner-observability
```

## Traps

- The runtime package must stay free of DOM and Cloudflare imports; `pipeline/` tests
  import it from `dist`, so `pnpm test` builds it first by design.
- A new subpath export needs both `types` and `default`, or the apps typecheck against
  nothing and pass.
- Binding names are the contract: a typo here becomes every later task's typo.

## Handoff

Wave-1 tasks import from `@handsontable/demo-runtime/telemetry` and register routes in
the scaffolded worker. Anything this task could not decide goes into its Outcome as `T00-D<k>`.

## Outcome

### What was built

- `packages/runtime/src/telemetry/` — ten files (`attrs.ts`, `metrics.ts`, `fingerprint.ts`,
  `scrub.ts`, `classify.ts`, `inbox.ts`, `lite.ts`, `sink.ts`, `facade.ts`, `convert.ts`) plus
  the `index.ts` barrel, exported as `@handsontable/demo-runtime/telemetry` (`packages/runtime/package.json`
  `"./telemetry"` subpath, both `types` and `default`). Pure — no DOM, no Cloudflare imports.
- `workers/o11y/` scaffold: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `src/env.ts`
  (declares `InboxWriterApi` per COMMON.md interface 1, plus the `Env` shape), `src/box.ts`
  (do-nothing `GrafanaBox` stub, T01's file per the shared-file table), `src/inbox/writer.ts`
  (do-nothing `InboxWriter` stub, T02's file), `src/index.ts` (501 on every contract §1 route,
  re-exports the two DO classes from their real files), `.dev.vars.example`. See T00-D9.
- `workers/api/src/analytics.ts`: `BOT_RE`/`isBot`/`deviceOf`/`browserOf`/`osOf` moved into
  `classify.ts`, byte-identical, re-exported so no importer's path changes.
- `workers/api/src/env.ts` + `wrangler.jsonc`: scaffold-only additions the task explicitly
  scoped to T00 — `RUNNER_EVENTS` (Analytics Engine), the `O11Y` service binding, `SENTRY_SCOPE`
  var (default `"full"`, contract §11). Values only; T05 (this file's real owner) wires usage.
- `apps/authoring/package.json`: `@grafana/faro-web-sdk` added as a real dependency (not just
  recorded) — see Dependencies below.
- Eight `pipeline/*.test.mjs` files (79 `node --test` cases): `telemetry-contract.test.mjs`
  (required name), `scrub-telemetry.test.mjs` (required name), `telemetry-convert.test.mjs`
  (required name), `telemetry-fingerprint.test.mjs` (required name), plus
  `telemetry-metrics.test.mjs`, `telemetry-inbox.test.mjs`, `telemetry-lite.test.mjs`,
  `telemetry-sink.test.mjs` (not named by the acceptance criteria, added because `toAePoint`'s
  runtime validation, the inbox key/NDJSON helpers, the lite payload's byte cap, and
  `clickhouseSink`'s wire format all have real logic the contract test
  does not exercise).

### Dependencies added (each verified on npm at time of task, pinned exactly where the task
asked for it)

| Package | Version | Where | Note |
|---|---|---|---|
| `@grafana/faro-web-sdk` | `2.12.1` | `apps/authoring/package.json` (added for real, not just recorded — the task's Goal is "T00 adds every new dependency," and a version recorded but not added would have shown up as a lockfile-diff finding on T06's PR instead) | authoring Faro SDK, unused until T06 imports it |
| `@cloudflare/containers` | `0.3.7` | `workers/o11y` | `GrafanaBox`'s base class |
| `jose` | `6.2.12` | `workers/o11y` | Access JWT verification (T02) |
| `source-map-js` | `1.2.1` | `workers/o11y` | drain-time symbolication (T03) |
| `@bufbuild/protobuf` | `2.15.0` | `workers/o11y` | OTLP protobuf decoder — see comparison below |
| `wrangler` | `4.136.3` | `workers/o11y` | exact pin |
| `@cloudflare/workers-types` | `5.20260923.1` | `workers/o11y` | exact pin; see concern below |
| `typescript` | `~5.6.0` | `workers/o11y` | matches the rest of the workspace, not pinned exactly (not in the task's explicit pin list) |
| `acorn` | `8.18.0` | already a `runner/package.json` devDependency (root) | no change needed — already present |


### OTLP protobuf decoder comparison

Built two minimal esbuild bundles (`--bundle --minify --format=esm --platform=neutral`) using
only each library's low-level wire-format Reader/Writer (not full reflective `.proto` decoding
— both a hand-rolled OTLP decoder and this comparison stay at the wire-primitive level; see
below for why the reflective mode is a Workers disqualifier for one of them):

| Candidate | Minified | Gzipped |
|---|---|---|
| `protobufjs/minimal` (`Reader`/`Writer` only) | 44.0 kB | 12.76 kB |
| `@bufbuild/protobuf/wire` (`BinaryReader`/`BinaryWriter`) | 10.7 kB | 3.67 kB |

`@bufbuild/protobuf` is ~4× smaller at both stages. Both round-trip a synthetic encode/decode
correctly at the wire level (verified with a plain Node script, not just a type check).

**Eval disqualifier for protobufjs's full API** (not just a size preference): `protobufjs`'s
reflective decode/encode/verify methods (`Root.fromJSON`/`Type#decode`, the path a generic
"decode this arbitrary OTLP shape" implementation would reach for) are generated at runtime via
`util/codegen.js`'s `Function.apply(...)` / `Function(source)()` (confirmed by reading the
installed package source, `eslint-disable-line no-new-func` comments and all). Workers disallow
dynamic code evaluation by default ("Code generation from strings disallowed for this
context"). `protobufjs/minimal`'s bare `Reader`/`Writer` avoid this (no codegen at all), but
`@bufbuild/protobuf` avoids it **and** is smaller **and** its normal (non-`/wire`) generated-message
API is also eval-free by construction (protobuf-es codegen produces static methods, never
`new Function`), so a hand-rolled wire-level decoder is not the only option later if the
ingest route ends up wanting full generated OTLP message types. **Decision: pin
`@bufbuild/protobuf`.** Not smoke-tested under a real `wrangler dev` request (T02's decode path
does not exist yet); the eval-safety claim rests on the source-code grep, not a runtime
Workers execution.

### Deviations (T00-D)

- **T00-D1 — scrub attribute rule.** The task text says "drop the forbidden attributes of
  contract §3"; ADR §E.4 says "drop unknown attributes." Implemented as one allowlist
  (`attrs.ts#ALLOWED_ATTRIBUTE_KEYS` = `RESOURCE_ATTRS` ∪ `STRUCTURED_METADATA_KEYS`) that
  `scrub.ts#allowlistAttributes` applies to every attribute/context bag — satisfies both
  readings at once (every §3-forbidden key is simply absent from the allowlist, and a future
  unknown key is dropped by the same mechanism with no code change).
- **T00-D2 — AE point shape and local-mode column names.** `toAePoint` always returns a
  fixed-width point (20 blobs, 20 doubles), unused slots `""`/`0`; the three universal resource
  attrs (`service_name`, `service_version`, `environment`, blob1–3) are always filled and are
  **not** part of any metric's own `blobs` list in the §5 registry (they are universal, not
  metric-specific — confirmed against the doc: no §5 row ever mentions them). The local
  ClickHouse table's columns are named identically to the AE slot names (`index1`, `blob1`…
  `blob20`, `double1`…`double20`) plus `timestamp`/`_sample_interval`, so a query written against
  real Analytics Engine and against the local shim differ only in endpoint — T01's
  `containers/o11y/local/clickhouse-init.sql` must use these exact column names.
- **T00-D3 — fingerprint internals.** FNV-1a 64 runs over the UTF-8 bytes of the normalised
  message (the natural choice for a JS string; pinned against the published test vectors:
  `""`→`cbf29ce484222325`, `"a"`→`af63dc4c8601ec8c`, `"foobar"`→`85944171f73967e8`).
  `stripCodeFrame` runs **before** `normalizeMonitorMessage`, not after — the doc's "the
  normalisation is `normalizeMonitorMessage` plus `stripCodeFrame`" names both but not an order,
  and `normalizeMonitorMessage`'s whitespace collapse destroys the line-anchored gutter/caret
  shape `stripCodeFrame` matches if it runs first.
- **T00-D4 — console-item tagging convention.** `scrub.ts#isConsoleItem` drops a Faro `log`
  item only when `payload.context["hot.kind"]` is `"console-error"` or `"console-warn"` (the
  existing `MonitorKind` vocabulary from `monitor.ts`). Faro's own console instrumentation is
  off per ADR §E.4, so this only matters if T06/T07 relay the demo-runtime console-warn/error
  bridge into Faro as a manual `pushLog` — if they do, they must tag it this way for the drop
  rule to find it; if they don't, this rule is inert (a console item never arrives) and costs
  nothing.
- **T00-D5 — lite beacon size cap.** "≤ 2 KB" (§9) is enforced as `LITE_PAYLOAD_MAX_BYTES = 2048`
  bytes of the serialised JSON body (`TextEncoder`-counted, not `.length` characters), and it is
  the **decisive** cap: `isValidLitePayload` rejects a payload that satisfies both inherited
  per-field caps (`LITE_MESSAGE_MAX = 500`, `LITE_STACK_MAX = 2000`, copied from `monitor.ts`'s
  `MONITOR_MESSAGE_MAX`/`MONITOR_STACK_MAX`) but whose total exceeds 2048 — measured
  (`pipeline/telemetry-lite.test.mjs`) that `st` alone at `LITE_STACK_MAX`, with every other
  field minimal, already runs ~2150 bytes, over budget by itself. T08's sender must truncate
  `st` well below its own field cap (documented in `lite.ts`) and re-validate, not just stay
  under `LITE_STACK_MAX`.
- **T00-D6 — scrub-then-convert order.** `convert.ts`'s `faroItemToRecord`/`beaconToRecord` both
  assume an **already-scrubbed** input (`scrubTelemetry` first, then convert), not the reverse.
  Scrubbing the richer Faro/beacon shape first catches fields `convert.ts` never looks at (e.g.
  stack-frame filenames); converting first and scrubbing the flat OTLP shape after would miss
  them. T02's route handler must call them in this order.
- **T00-D7 — `GrafanaBox`'s base class and the missing `containers` block.** `GrafanaBox`
  extends `@cloudflare/containers`' `Container<Env>` (matching the contract), with no
  `containers` entry in `wrangler.jsonc` yet — `containers/o11y/`'s Dockerfile does not exist
  until T01. Measured: `wrangler deploy --dry-run` accepts this combination (the bundle grows
  from ~2 KiB to ~54 KiB, pulling in `@cloudflare/containers`' runtime, but lists the binding
  same as any other) — it was **not** deployed for real, so whether a real `wrangler deploy`
  also accepts a `Container` subclass with no matching `containers` entry is unconfirmed. T01
  adds the entry alongside real container behaviour; if a real deploy turns out to reject it,
  that is T01's problem to discover, not a T00 regression (dry-run, the task's own acceptance
  criterion, passes either way).
- **T00-D8 — Access placeholders.** `ACCESS_TEAM_DOMAIN` (`"handsontable.cloudflareaccess.com"`,
  a plausible-convention guess) and `ACCESS_AUD` (`""`) are placeholders — the real Access
  application does not exist yet. T03 creates it and fills in both.
- **Left out of `wrangler.jsonc`, per the controller's explicit allowance**: the Workers
  rate-limiting binding gating `collect`/`lite` (needs a real namespace id from the dashboard,
  T02's job) and the `containers` block for `GrafanaBox` (T01's job, see T00-D7).
- **T00-D9 — `InboxWriter`/`GrafanaBox` live in their real owners' files, not `env.ts`.**
  First draft put both do-nothing stub classes directly in `env.ts`; moved to
  `workers/o11y/src/box.ts` (`GrafanaBox`, T01's row in COMMON.md's shared-file table) and
  `workers/o11y/src/inbox/writer.ts` (`InboxWriter`, T02's row) after review, so each task edits
  the file it already owns instead of also having to touch `env.ts` and `index.ts`. `env.ts` now
  only declares `InboxWriterApi` and `Env`, importing the two classes' **types** (never their
  values) from those files for the `DurableObjectNamespace<T>` parameters. The two files'
  references back to `Env` and to each other's types are circular but type-only
  (`import type`), so there is no runtime import cycle — verified with a clean `tsc --noEmit`
  and a real `wrangler deploy --dry-run`. **T01 handoff**: edit `box.ts` in place (give
  `GrafanaBox` real behaviour, add the `containers` block to `wrangler.jsonc` in the same
  change per T00-D7) — nothing in `env.ts` or `index.ts` needs to change. **T02 handoff**: same,
  for `inbox/writer.ts` and `InboxWriter`, alongside the new `pack.ts`/`dedupe.ts`/`registry.ts`
  files in `workers/o11y/src/inbox/`.

  Two things worth being explicit about, since this task's own "Owns" row lists only
  `workers/o11y/{package.json,tsconfig.json,wrangler.jsonc,src/index.ts,src/env.ts}`, not
  `src/box.ts` or `src/inbox/writer.ts`: **(a)** those two files did not exist before this task
  and no other task owns them *yet* — T01/T02's shared-file-table rows name them as their
  future home, so creating them as scaffolding (empty of real behaviour, per this task's own
  scope) is the same kind of act as creating `src/index.ts` itself, not a boundary violation;
  **(b)** the controller's instruction (COMMON.md interface 1) was to type `INBOX_WRITER` as
  `DurableObjectNamespace<InboxWriterApi>` directly. It is typed as
  `DurableObjectNamespace<InboxWriter>` instead (the stub class, which `implements
  InboxWriterApi`). Measured, not assumed: a direct probe (`type Probe =
  DurableObjectNamespace<InboxWriterApi>`, `@cloudflare/workers-types` 5.20260923.1) fails with

  ```
  error TS2344: Type 'InboxWriterApi' does not satisfy the constraint 'DurableObjectBranded'.
    Property '[__DURABLE_OBJECT_BRAND]' is missing in type 'InboxWriterApi' but required in type
    'DurableObjectBranded'.
  ```

  confirming the deviation is required, not a preference. `InboxWriterApi` is still exactly what
  T01 and T02 code the RPC shape against, unchanged.
- **T00-D10 — `toAePoint`'s outcome/reason check is runtime-only, not a compile-time one.**
  `HotAttrs.outcome`/`.reason` are typed `string` (§5's per-metric enums have no type-level
  encoding), so `tsc` accepts any string at every call site; only actually calling `toAePoint`
  validates one, by throwing. Confirmed while building the three-package typecheck probes: a
  probe passing `outcome: "nope"` produced no compile error at all (`TS2578: Unused
  '@ts-expect-error' directive` when one was added expecting it to fire) — the probe had to be
  rewritten to use a wrong **type** (a `number`) instead, to prove the import resolves real
  types and not `any`. This matters for T02: the ingest route extracts browser metrics from a
  Faro item's `context`, which is client-controlled, and calls `toAePoint` with those values —
  a crafted `outcome` throws at runtime. T02's route handler must catch that (or pre-validate
  against `METRICS[metric].values` before calling), or one malformed browser metric becomes a
  500 instead of an `o11y.ingest` `dropped` point. Documented directly on `toAePoint`'s doc
  comment in `metrics.ts` too, not only here. `faroItemToRecord` now has the same shape of
  problem and the same fix: it throws if `item.type` is outside `attrs.ts#HOT_KINDS`
  (`exception`/`log`/`event`/`measurement` — `"trace"` is a real `TransportItemType` value Faro
  allows but this contract does not, since no trace is ever exported, ADR §C.4), reachable from
  the same client-controlled `POST /telemetry/collect` body. T02's route handler needs one catch
  around both call sites, not two different ones.
- **T00-D11 — `scrub.ts`'s Faro-shape types, typechecked against the real SDK, not just read.**
  With `@grafana/faro-web-sdk` now a real dependency (`apps/authoring`), a temporary probe
  proved two things the first draft got wrong: **(a)** `ScrubbableFaroItem.type` must be `string`,
  not a literal union — Faro's real `type` is the string *enum* `TransportItemType`, and TS does
  not consider an enum member assignable to an unrelated string-literal union even though the
  runtime values are identical; **(b)** none of the nested Faro shapes (`ScrubbableFaroPayload`,
  `ScrubbableFaroMeta`, `ScrubbableFaroStackFrame`, `ScrubbableOtlpRecord`) may carry a
  `[key: string]: unknown` index signature — a real `TransportItem`'s nested types have none, and
  TS requires the *source* type passed at a call site to also have a matching index signature
  when the *target* parameter type declares one, so a real Faro item failed to satisfy the
  original interfaces even though every field the scrubber reads was correctly declared. Both
  fixed; a concrete `TransportItem<LogEvent>` / `TransportItem<ExceptionEvent>` now passes into
  and back out of `scrubTelemetry` with zero casts (verified with the probe, not assumed). One
  genuine friction point remains and is documented in `scrub.ts` itself for T06: Faro's actual
  `BeforeSendHook` type is generic over the *whole* item union, `TraceEvent` included, which this
  module does not model (no traces, same ADR §C.4 reason as T00-D10's `faroItemToRecord` guard) —
  wiring the real hook needs exactly one `as unknown as ScrubbableFaroItem` / `as TransportItem |
  null` cast pair at that one boundary, which is expected, not a defect.
- **ClickHouse `timestamp` format, measured against a real container running T01's actual
  schema — three iterations, not one.** T01 (running in parallel) had already committed
  `containers/o11y/local/clickhouse-init.sql` — read directly from T01's worktree, read-only, per
  COMMON.md. Column names matched exactly (`index1`, `blob1`–`blob20` `String`, `double1`–`double20`
  `Float64`, `_sample_interval` — T00-D2 held); `timestamp` is `DateTime64(3)`. What actually
  reaches that column was measured, not guessed, with a throwaway `clickhouse/clickhouse-server:
  24.10-alpine` container (T01's own pinned tag) on port 4123 (this task's port block), running
  T01's DDL unmodified, torn down after:
  - **v1, a bare Unix-seconds integer** (the original code): **wrong**, and not merely imprecise as
    first assumed — ClickHouse does not read a plain integer into `DateTime64(3)` as seconds at
    all, it reads it as raw milliseconds at the column's own declared scale. `1758628800` (meant
    as seconds) landed on `1970-01-21 08:30:28.800`, off by 1000×, confirmed via
    `toUnixTimestamp64Milli`.
  - **v2, a `'YYYY-MM-DD HH:MM:SS.sss'` string**: round-tripped exactly correct under the
    container's own UTC timezone — but a same-query check with `session_timezone=Asia/Tokyo` on
    the identical string produced a value 9 hours off. A naive datetime string is parsed in the
    server's configured timezone, which nothing here pins, so this was not safe to ship either.
  - **v3, a raw epoch-millisecond integer** (`Date.getTime()`, what `clickhouseSink` sends now):
    round-tripped byte-for-byte identical via `toUnixTimestamp64Milli`, and being a pure tick
    count it cannot be timezone-dependent by construction — no server-timezone pin needed.
  `clickhouseTimestamp` (exported, tested in `pipeline/telemetry-sink.test.mjs`) implements v3.
  The throwaway container (`docker run --name t00-ch-probe ... clickhouse/clickhouse-server:24.10-alpine`,
  port 4123) was removed afterward (`docker rm -f t00-ch-probe`, confirmed absent).
- **`redactPreviewHosts` now runs on every string in a scrubbed record, not only the fields named
  individually.** A third review pass found the Scope line "`redactPreviewHosts` on every string"
  was only implemented for five specific fields (`meta.page.url`, stack-frame filenames, message,
  value, OTLP body) — an allowlisted attribute value (`session.id`, `hot.framework`, both
  client-supplied) or `payload.type` could still carry a preview host through untouched.
  `scrubTelemetry` now walks every string leaf of the whole clone with `redactPreviewHosts` as a
  final pass, after the targeted rules (idempotent, so order does not matter) — covered by two
  new isolated cases in `scrub-telemetry.test.mjs` (a preview host inside `session.id`, and inside
  `payload.type`), each reverted and seen red.
- **`HOT_KINDS`, added for the guard above, is now also pinned by
  `telemetry-contract.test.mjs`** — the same doc-parses-itself rule as every other closed set: it
  extracts the four backtick values after `` `hot.kind` `` in the §3 "Structured metadata only"
  paragraph and compares them to `attrs.ts#HOT_KINDS`, reverted (a doc-only edit adding a fifth
  value) and seen red.

### Post-review fixes (not T00-D — these are correctness fixes matching the contract, found by a
review pass before declaring done, not open decisions)

- **`toAePoint` now defaults `double1` (count) to `1` on every point**, universally, not only
  for metrics whose own §5 "Doubles" column happens to list `count`. §4's reading rule ("1 per
  point unless pre-aggregated," every count read as `SUM(_sample_interval * double1)`) applies
  to every metric, the same way blob1–3 are universal regardless of a metric's own "Blobs used"
  column. Before this fix, `preview.ready_ms`, `web_vital`, `session.start_ms`,
  `container.boot_ms` and others always stored `double1 = 0` — every count-based query for them
  (T04's alert thresholds, T09's panels) would have read zero forever. An explicit
  `values.count` still overrides the default 1 for a genuinely pre-aggregated point.
- **`faroItemToRecord` now always sets `hot.kind = item.type`** (§3's closed set:
  `exception`/`log`/`event`/`measurement`), overwriting whatever the client's context carried
  under that key. It was never set there at all before this fix, though `beaconToRecord` always
  set it correctly — an asymmetry a reviewer would have caught immediately in T02/T03's own
  dashboards (`hot.kind` present on every beacon-sourced row, absent on every Faro-sourced one).
- **The demo-runtime console-relay marker (T00-D4) moved from `context["hot.kind"]` to
  `context["hot.relay"]`**, a consequence of the fix above: `hot.kind`'s value set is now always
  `item.type`, so a `"console-error"`/`"console-warn"` value stored there would never survive to
  be checked by `isConsoleItem`. `hot.relay` is also not on `ALLOWED_ATTRIBUTE_KEYS`, so the
  marker itself is scrubbed away even if this check ever missed one.
- **`scrub.ts` now strips query strings/fragments from stack-frame filenames too**, not only
  `meta.page.url` — they are URL-valued fields, and §3's rule covers "every" one; a bundler's
  cache-busting `?t=…` query string shows up there routinely.

### Sandbox probes

None — T00 is not one of T01/T02/T03, no probe section applies.

### Test-failing-when-reverted evidence

Every new test file was run once green on first write, then deliberately broken by reverting
the implementation (not the test) and re-run to confirm a red failure for the right reason,
then restored and re-verified green. Full command output is in the T00 report
(`.superpowers/sdd/README/T00-report.md`); summary:

| File / rule reverted | Test(s) that went red |
|---|---|
| `docs/observability-contract.md` §5 outcome value (doc edited alone) | `telemetry-contract.test.mjs` §5 subtest |
| `metrics.ts` §5 outcome value (module edited alone) | `telemetry-contract.test.mjs` §5 subtest |
| `fingerprint.ts`: `stripCodeFrame` removed from `fingerprint()` | the code-frame case in `telemetry-fingerprint.test.mjs` |
| `convert.ts`: `msToUnixNano` back to `ms * 1e6` | the boundary-precision case in `telemetry-convert.test.mjs` |
| `scrub.ts`: each of 9 individual rules (console drop, drop user, reduce browser meta, page-url scrub, stack-frame redact, message scrub, context allowlist, OTLP body scrub, OTLP attrs allowlist) disabled one at a time | exactly the case(s) written to prove that rule, in `scrub-telemetry.test.mjs` |
| `metrics.ts`: `toAePoint`'s `checkAllowed` disabled | the three validation cases in `telemetry-metrics.test.mjs` |
| `inbox.ts`: `inboxKey` switched from `getUTCHours` to `getHours` | the UTC-vs-local case (and two others) in `telemetry-inbox.test.mjs`, run under `TZ=Europe/Warsaw` to force a real divergence |
| `lite.ts`: the total-byte check short-circuited to `true` | the T00-D5 case in `telemetry-lite.test.mjs` |
| `docs/observability-contract.md` §4 `outcome`'s slot (`blob8` → `blob9`, doc edited alone) | `telemetry-contract.test.mjs` §4 subtest |
| `metrics.ts`: `toAePoint`'s `double1` default changed from `1` back to `0` (the post-review count fix) | the new count-default case in `telemetry-metrics.test.mjs` |
| `convert.ts`: `attributes[ATTR_HOT_KIND] = item.type` removed from `faroItemToRecord` (the post-review `hot.kind` fix) | the hoist case and the dedicated `hot.kind` case in `telemetry-convert.test.mjs` |
| `scrub.ts`: `stripQueryAndFragment` removed from the stack-frame filename line (the post-review query-strip fix) | the new stack-frame query-string case in `scrub-telemetry.test.mjs` |
| `sink.ts`: `clickhouseTimestamp` v2 (string) reverted to v1 (bare Unix-seconds) | `telemetry-sink.test.mjs`, `not ok 3` |
| `convert.ts`: the `HOT_KINDS` guard removed from `faroItemToRecord` (post-review `hot.kind` guard) | `telemetry-convert.test.mjs`, `not ok 9` |
| `sink.ts`: `clickhouseTimestamp` v3 (raw ms integer) reverted to v2 (seconds via `Math.floor(.../1000)`) — the measured-wrong-again case | `telemetry-sink.test.mjs`, `not ok 2` and `not ok 3` |
| `scrub.ts`: the final `redactStringsDeep` walk removed from both branches | `scrub-telemetry.test.mjs`, `not ok 14` and `not ok 15` |
| `docs/observability-contract.md` §3 `hot.kind` parenthetical (a 5th value added, doc edited alone) | `telemetry-contract.test.mjs` §3 subtest |

### Verify — commands run, exit codes

All run via `rtk proxy <command>; echo "exit=$?"` from `runner/` (or the named subdirectory),
per COMMON.md. rtk's own summaries were not trusted; exit codes and raw output were.

```
rtk proxy pnpm install                                           exit=0
rtk proxy pnpm --filter @handsontable/demo-runtime build          exit=0
rtk proxy pnpm -r run typecheck                                   exit=0  (5 of 6 workspace projects — pipeline has no typecheck script, unrelated to this task)
rtk proxy pnpm test                                                exit=1 (1242 tests, 1239 pass, 1 pre-existing unrelated failure, 2 pre-existing todo — see Concerns; all 79 telemetry cases pass)
rtk proxy pnpm install --frozen-lockfile                           exit=0 (CI's install mode)
( cd workers/o11y && rtk proxy npx wrangler deploy --dry-run )    exit=0
( cd workers/api && rtk proxy npx wrangler deploy --dry-run )     exit=0
node scripts/check-test-presence.mjs feat/runner-observability    exit=0 ("15 source file(s) changed, with a matching test change")
```

(This is the final run, after every fix below — including the revert-checks for them, each
restored before this run.)

Also, per the acceptance criteria's exact import line, typechecked
`import { toAePoint, scrubTelemetry, fingerprint } from "@handsontable/demo-runtime/telemetry"`
in `workers/api`, `workers/o11y` and `apps/authoring` via temporary probe files. The first
attempt used a deliberate `@ts-expect-error` on `toAePoint("api.request", {}, { …, outcome:
"nope" })`, expecting the per-metric outcome enum to be a compile-time error — it was not
(`TS2578: Unused '@ts-expect-error' directive`; see T00-D10, this is real and load-bearing for
T02, not a probe mistake). The probe was rewritten to a genuine type error instead
(`outcome: 123`, a `number` where the type is `string`) to prove the import resolves real types
and not `any` — all three packages passed with that version (the `@ts-expect-error` correctly
suppressed the one real error and nothing else fired), and a control version with no
`@ts-expect-error` at all confirmed the mismatch is real (`error TS2578` only ever appears when
there is nothing to suppress; removing the marker line entirely instead produces the ordinary
`TS2322` type error, confirmed for the `workers/api` probe). All three probe files were deleted
afterward — none of `workers/api`, `apps/authoring` is a file this task owns permanently, and
`workers/o11y/src/index.ts` stays a clean 501-stub per scope.

Also measured, then reverted: removing `"types"` from the `"./telemetry"` export condition did
**not** break resolution under this repo's `moduleResolution: "Bundler"` — tsc still found the
real `.d.ts` (confirmed with a "does this exported member exist" probe, which correctly errored
`TS2305`, not an empty error log that would mean silent `any`) — so the task file's stated trap
does not reproduce here, though `types` was kept anyway (correct regardless, and other
tools/resolution modes may not be as lenient).

**Fingerprint identical in browser and Node**, measured rather than assumed: bundled
`packages/runtime/dist/telemetry/index.js` with `esbuild --bundle --format=iife
--target=chrome87,firefox78,safari14,edge88` (`apps/authoring/vite.config.ts` sets no explicit
`build.target` and no legacy-browser plugin, so Vite's own default — "browsers that support
native ES modules," roughly this same baseline — applies), then evaluated the bundle in
`node:vm` with `TextEncoder`/`crypto` injected into the sandbox. `fingerprint("ctx","")` /
`"a"` / `"foobar"` produced the exact same pinned hex values as the plain-Node run, and the
demo-runtime ladder collapse still collapsed to one fingerprint. esbuild does not (cannot)
downlevel `BigInt` literals — an unsupported target fails the build outright rather than
silently emitting wrong values — so a successful, value-correct bundle at this target is real
evidence, not just "the code has no browser-only APIs."

### Concerns / follow-ups

- The one `pnpm test` failure (`the pin tracks its own major's starter bucket`) is pre-existing
  on `feat/runner-observability` before this task's changes — confirmed by running the baseline
  suite before writing any code (same single failure, same test name). Unrelated to telemetry;
  not investigated further as out of scope.
- `workers/api`'s existing `@cloudflare/workers-types` pin (`^4.20250101.0`) is behind what its
  own `wrangler@4.108.0` actually wants as a peer (`^5.20260706.1` — visible as a pnpm peer-
  dependency warning during `pnpm install`, pre-existing, not caused by this task).
  `workers/o11y` was pinned to the current `5.20260923.1` instead, so the two workers now carry
  different major versions of the same types package. Not fixed here — `workers/api/package.json`
  is T05's file, and this is pre-existing drift, not a T00 regression.
- The OTLP decoder choice (`@bufbuild/protobuf`) is backed by a source-code eval-safety check
  and a bundle-size measurement, not a real `wrangler dev` request — T02 should smoke-test its
  first real decode call under `wrangler dev` before leaning on the "no eval" claim in
  production.
- `GrafanaBox extends Container<Env>` with no `containers` block (T00-D7) was only proven safe
  under `--dry-run`; T01 should confirm a real deploy accepts it too, or drop back to a plain
  `DurableObject` stub if not.
- T00-D10/D11: T02's route handler must catch (or pre-validate) two call sites reachable from
  client-controlled `POST /telemetry/collect` input — `toAePoint` (a crafted `outcome`/`reason`)
  and `faroItemToRecord` (a crafted `item.type`) — or a single malformed payload becomes a 500.
- `scrubTelemetry`'s Faro-shape types were verified against the real `@grafana/faro-web-sdk`
  types for the common case (a concrete `TransportItem<LogEvent>` etc., zero casts), but wiring
  Faro's actual generic `BeforeSendHook` needs one documented cast (T00-D11) — T06 should confirm
  that cast still typechecks once its own Faro `Config` is written, since this was only checked
  with a standalone probe, not T06's real init code.
