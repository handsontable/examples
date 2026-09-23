# T00 — Telemetry contract module, o11y scaffolds, dependencies

| | |
|---|---|
| Status | todo |
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

_Filled in when done._
