# ADR-0029: Starter-example buckets, the single-seed image, and frozen-branch backports

**Status:** Accepted (DEV-2213 / DEV-2222; supersedes ADR-0021 decision 10)

## Context

ADR-0021 versioned the docs examples but left starters as one hand-maintained
scaffold per framework, rewritten to any selected major (15–19) purely by
re-pinning `package.json` at runtime (`applyHandsontableVersion`). That
conflates content version with package version exactly the way ADR-0021's
decision 1 fixed for docs: an 18-authored starter pinned to 15 works only
while the source happens to avoid every 17+/18+ API. Its decision 10
deliberately deferred the problem to "a separate empirical pass".

That pass ran (DEV-2107 era + the starter matrix): the breakage is real and
structural, not incidental — `handsontable/themes` exists only from 17.0.0
(the five theme-API recipes), `@handsontable/angular-wrapper` has no 15.x
release at all, wrapper-16's `HotTableComponent` is `standalone: false`, and
DEV-2200's best-practice modernization (no CSS imports, JS `theme:` object)
is *impossible* below 17 because nothing injects core CSS there. A single
master source cannot be simultaneously correct for 15 and idiomatic for 18+.

Meanwhile PR #144's first cut of per-bucket container contexts baked one
node_modules per (framework, bucket) — 24 contexts — which doubled the image
and stalled `wrangler deploy` ~1 h in `exporting layers` (norm ~8 min).

## Decision

1. **Starter buckets mirror docs buckets, keyed by major.** One generated
   bucket per supported major (`MIN_BUCKET_MAJOR = 15` … npm
   `dist-tags.latest`'s major) plus `next`, under
   `apps/authoring/public/starter-examples/<bucket>/`. Unlike docs buckets
   (`major.minor`, one per release branch), starter buckets are major-only —
   per-minor keys would mean ~12 live branches instead of one per major.

2. **Bucket source = `prod-examples/<major>` branch when it exists, else
   master; `next` is always master.** Resolution happens in
   `.github/workflows/import-starters.yml`'s prepare job via
   `git ls-remote`. Pipeline code always runs from master; the branch
   contributes only `examples/**` (sparse checkout). Cutting a branch
   redirects its bucket with zero workflow changes, which also defines the
   rollout for a new major: its bucket tracks master (absorbing
   modernization on every re-import) until the branch is cut, so the
   snapshot is born current.

3. **Frozen branches take cherry-picks only** — compat/build/security fixes,
   applied newest → oldest as far as relevant. Policy, eligible classes, and
   the dependency-minimal rule live in [`docs/backport-policy.md`](../backport-policy.md).
   The split this enforces today: master (17+/next buckets) is import-free
   and themes via the JS `theme:` object (DEV-2200); `prod-examples/15|16`
   keep `handsontable/styles/*.css` imports + string `themeName`, because
   neither `injectCoreCss` nor `handsontable/themes` exists below 17.0.0.

4. **Pins are resolved, never authored.** Branch sources keep `"latest"`;
   `pipeline/import.mjs` resolves the bucket's `hotVersion` from the npm
   registry (newest stable of the major; a major with no stable release
   fails generation), rewrites every dependency whose name contains
   `handsontable` (except `@handsontable/pikaday`) in lockstep, and
   regenerates the lockfile. The rewrite is byte-identical to
   `applyHandsontableVersion`'s runtime re-application — pinned by the
   byte-identity test in `pipeline/import.test.mjs`, which is what makes the
   Tier-2 frozen-install fast path possible at all.

5. **Bucket membership is floored, not branched.** `minCoreMajor` in
   `config/frameworks.json` filters frameworks out of too-old buckets
   (angular < 16: no wrapper release; the five theme-API recipes < 17: no
   `handsontable/themes` export). Directories for excluded frameworks stay
   on the frozen branches — the importer skips them; deleting one that a
   bucket *does* require hard-fails that bucket and, because the publish job
   gates on the whole matrix, blocks the generated PR for every bucket.

6. **One baked node_modules seed per framework, a fingerprint per
   (framework, bucket)** — the #146 single-seed design, replacing #144's
   per-bucket bake that hit the image-size wall. `scripts/prepare-container.mjs`
   bakes only the seed bucket's (default 18) node_modules and emits a
   `sha256(package.json + pnpm-lock.yaml)` fingerprint for **every** bucket
   into `workers/api/src/frameworks.generated.ts`, all pointing at the one
   seed. This is correct because the seed is a warm cache, not a contract:
   a pristine session's frozen `pnpm install --frozen-lockfile` reconciles
   the seed to the submitted self-consistent package.json + lock, downloading
   only the delta (today the HOT core/wrapper pins, ~1.3 s). A fingerprint
   match hard-fails rather than retrying non-frozen, so
   `pipeline/frameworks-generated.test.mjs` recomputes every fingerprint
   against the bucket artifacts (drift test, `checked >= 40` — arithmetic
   over the bucket set, and the tripwire when a bucket is added or dropped).
   Consequence of the seed model: every dependency a frozen branch diverges
   from the seed grows that bucket's boot download — hence the
   dependency-minimal backport rule.

7. **Regeneration is event-driven.** Pushes touching `examples/**` on master
   or `prod-examples/**`, a weekly cron (re-pins after patch releases), and
   manual per-bucket dispatch all funnel into the same generated
   `chore/starter-example-buckets` PR (create-pull-request pinned by SHA —
   the job holds write permissions). The publish job rebuilds
   `catalog.json` and the container fingerprints in the same commit, keeping
   decision 6's drift test green by construction.

## Consequences

- ADR-0021 decision 10 is superseded: starter support per major is now
  empirically enforced by construction (bucket membership + frozen branches
  + the e2e starter matrix) instead of assumed. The matrix run of 2026-08-12
  is the baseline: all starters green at 15–18.
- The version dropdown serves genuinely different *content* per major for
  starters, same as docs examples — the last consumer of the "one source,
  any pin" model is gone.
- Branch count grows by one per Handsontable major. The static-asset ceiling
  concern from ADR-0021 decision 11 applies to starter buckets too, but at
  ~40 files per bucket it is decades away for starters; docs buckets remain
  the binding constraint.
- The three copies of the major floor (`version.ts` `DEFAULT_MIN_MAJOR`,
  `import.mjs` `MIN_BUCKET_MAJOR`, `import-starters.yml` `MIN_MAJOR`) must
  move together; each site cross-references the others.
- Writing to a `prod-examples/**` branch is production-adjacent: it
  regenerates a served bucket on merge of the generated PR. Branch pushes go
  through per-round PRs for review.
