# Starter compatibility matrix

`e2e/starter-matrix.spec.ts` empirically verifies every starter in the
repo-root `examples/` directory (as cataloged in `catalog.json`) against every
Handsontable major the app claims to support (15-19) — DEV-2102 / ADR-0021
decision 10. It boots each starter/major combination against an
already-running instance, checks that a Handsontable grid actually renders
(not just that the dev server responds), and records the result.

It is **not** part of the deterministic PR suite (`pnpm e2e`) — it's an
opt-in, manually-run check.

## Running it

```sh
E2E_BASE_URL=https://demos.handsontable.com pnpm e2e:matrix
pnpm e2e:matrix:report
```

- `pnpm e2e:matrix` sets `E2E_STARTER_MATRIX=1` and runs at `--workers=2`,
  writing JSON results to `test-results/starter-matrix.json`.
- `pnpm e2e:matrix:report` turns that JSON into a starter × major markdown
  table, written to `docs/reports/starter-matrix-<date>.md` (and printed to
  stdout — paste straight into a ticket/PR comment). It accepts multiple JSON
  paths if you ran the matrix in chunks (see below).

Against a local stack instead of prod: point `E2E_BASE_URL` at your local
`vite --port 5173` authoring dev server, with the API worker running on 8787
(see the "Full stack" section above) and `VITE_API_BASE` baked accordingly.

### Running it in chunks

The full matrix is ~80 starter×major combinations and can take well over an
hour end to end. If you can't leave it running unattended for that long (a
sleeping/locked laptop kills the process), run subsets with `--grep`, each to
its own JSON file:

```sh
E2E_STARTER_MATRIX=1 E2E_BASE_URL=https://demos.handsontable.com \
  PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/matrix-batch1.json \
  npx playwright test e2e/starter-matrix.spec.ts --workers=2 --retries=1 \
  --grep 'matrix: (react|vue) @' --reporter=list,json
```

**Use an absolute path outside `test-results/` for `PLAYWRIGHT_JSON_OUTPUT_NAME`
when chunking.** Playwright wipes its default `outputDir` (`test-results/`) at
the start of every run — a second chunk's run will silently delete the first
chunk's JSON if both write there. Then merge:

```sh
pnpm e2e:matrix:report /tmp/matrix-batch1.json /tmp/matrix-batch2.json ...
```

## Prod concurrency cap

Container-engine starters (`engine: "container"` in `catalog.json`) each boot
a real Cloudflare Sandbox container via `POST /api/session`. Production caps
the live-preview `Sandbox` class at **5 concurrent instances**
(`workers/api/wrangler.jsonc`: `max_instances: 5`, separate from
`BuilderSandbox`'s `max_instances: 3` for the unrelated demo-sharing/build
pipeline, which this matrix never touches). The `e2e:matrix` script runs at
`--workers=2` to leave headroom for real traffic — don't raise it without
checking current prod load, and never run multiple `playwright test`
invocations against prod concurrently (their worker pools stack).

## What it checks, and its limits

Per combo: the preview reaches "Live" (not stuck booting or in an error
state), the Handsontable grid actually renders (`.handsontable .htCore td`
count > 0 — catches "server responded but nothing mounted"), zero unexpected
console/page errors, and that the requested version reached the session.
Sandpack-engine starters additionally verify the loaded Handsontable version
via the network request URL; container-engine starters can only confirm the
*requested* version was pinned in `package.json` (`Handsontable.version` is
typically unavailable in-frame for ESM bundles) — this is reported as
`unverified`, not a failure.

A major with no stable npm release yet (checked live against the npm
registry, not the app's own sliced `/api/versions` listing) is skipped, not
failed.

See `docs/reports/` for the latest run's findings and the resulting decision
on `packages/runtime/src/version.ts`'s minimum-major guard.
