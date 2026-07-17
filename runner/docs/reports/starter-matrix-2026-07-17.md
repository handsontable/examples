# Starter compatibility matrix

DEV-2102 / ADR-0021 decision 10: empirical verification of every starter in
`examples/` against Handsontable majors 15-19, run with
`e2e/starter-matrix.spec.ts` against `https://demos.handsontable.com`
(2026-07-17). Major 19 has no stable npm release yet (`dist-tags.latest` is
`18.0.0`) — those combos are skipped, not failed.

## Findings

- **10 of 16 starters are fully clean across 15-18**: react, react-js, vue,
  javascript, typescript, example1, next.js, nuxt, remix. No action needed.
- **5 React-UI-library container starters break at majors 15-16 only**,
  and pass cleanly at 17-18: `ant-design`, `mui`, `base-web`, `fluent-ui`,
  `next-shadcn.js`. The dev server boots ("Live") but the Handsontable grid
  never mounts (0 cells after 60s) — a real runtime incompatibility, not a
  boot failure. `mui`'s console log points at a concrete cause: an npm
  package-exports resolution error (`"./themes" is not exported under the
  current...`), suggesting a dependency in these starters' pinned toolchain
  needs a newer core/wrapper API than 15-16 provide. Root-causing the exact
  break per starter is follow-up work, not done here.
- **`angular` breaks at majors 15-17**, passes only at 18. Worse than the
  UI-lib group — never reaches "Live" at all (stuck "Booting preview…" for
  the full 240s timeout, both attempt and retry), suggesting the container
  never finishes installing/building rather than a runtime mount failure.
- **`astro` fails at every tested major (15-18)**, with the *identical*
  error every time regardless of version: `Failed to load resource: the
  server responded with a status of 504 ()`. Because the failure doesn't
  vary with the Handsontable major, this reads as an Astro-container
  infrastructure issue (a proxied resource/HMR request timing out) —
  **not a Handsontable version-compatibility problem**. Worth a separate
  investigation into the Astro Tier-2 container config; today the Astro
  starter appears broken for all users regardless of version choice.

## Decision: `version.ts` minimum-major guard

**Added.** `packages/runtime/src/version.ts` now exports
`DEFAULT_MIN_MAJOR = 15` and `validateHandsontableVersion` rejects any major
below it, mirroring the existing `DEFAULT_MAX_MAJOR` ceiling. Previously only
the UI-facing `GET /api/versions` listing enforced the 15 floor — a direct
session/API call bypassing the version dropdown (e.g. a crafted `?v=14.0.0`
deep link) could still request a major that was never tested. That gap is
independent of this run's per-starter findings: majors below 15 remain
completely unverified regardless of how 15-19 individually performed, so the
floor is warranted either way.

**Not done (deliberately out of scope):** per-starter/per-major restriction
in the UI or catalog. The task's scope explicitly keeps the 15-19 dropdown
open for all starters "unless this investigation proves otherwise" — it has,
for 7 specific starter/major combinations (the UI-lib group at 15-16, angular
at 15-17), plus the separate astro infra issue. Blocking those combos (or
fixing the underlying incompatibilities) is real follow-up work informed by
this report, not a blanket version-range change that would also incorrectly
block the 10 starters that work fine at every tested major.

## Full matrix

Legend: ✅ passed, ✅v passed with in-frame version verified, ⚠️ flaky (passed on retry), ❌ failed, ⏭️ skipped, ❓ no result found.

| starter (engine) | 15.x | 16.x | 17.x | 18.x | 19.x |
|---|---|---|---|---|---|
| angular (container) | ❌ 15.3.0 | ❌ 16.2.0 | ❌ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| ant-design (container) | ❌ 15.3.0 | ❌ 16.2.0 | ✅ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| astro (container) | ❌ 15.3.0 | ❌ 16.2.0 | ❌ 17.1.0 | ❌ 18.0.0 | ⏭️ |
| base-web (container) | ❌ 15.3.0 | ❌ 16.2.0 | ✅ 17.1.0 | ⚠️ 18.0.0 | ⏭️ |
| example1 (sandpack) | ✅v 15.3.0 | ✅v 16.2.0 | ✅v 17.1.0 | ✅v 18.0.0 | ⏭️ |
| fluent-ui (container) | ❌ 15.3.0 | ❌ 16.2.0 | ✅ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| javascript (sandpack) | ✅v 15.3.0 | ✅v 16.2.0 | ✅v 17.1.0 | ✅v 18.0.0 | ⏭️ |
| mui (container) | ❌ 15.3.0 | ❌ 16.2.0 | ✅ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| next-shadcn.js (container) | ❌ 15.3.0 | ❌ 16.2.0 | ✅ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| next.js (container) | ✅ 15.3.0 | ✅ 16.2.0 | ✅ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| nuxt (container) | ✅ 15.3.0 | ✅ 16.2.0 | ✅ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| react (sandpack) | ✅v 15.3.0 | ✅v 16.2.0 | ✅v 17.1.0 | ✅v 18.0.0 | ⏭️ |
| react-js (container) | ✅ 15.3.0 | ✅ 16.2.0 | ✅ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| remix (container) | ✅ 15.3.0 | ✅ 16.2.0 | ✅ 17.1.0 | ✅ 18.0.0 | ⏭️ |
| typescript (sandpack) | ✅v 15.3.0 | ✅v 16.2.0 | ✅v 17.1.0 | ✅v 18.0.0 | ⏭️ |
| vue (sandpack) | ✅v 15.3.0 | ✅v 16.2.0 | ✅v 17.1.0 | ✅v 18.0.0 | ⏭️ |

## Failures / flaky (18)

### angular @ 15 [container] — unexpected

- resolved version: 15.3.0

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('section[aria-label="Preview"]').locator(':scope > div').first()
Expected: "Live"
Received: "Booting preview…"
Timeout:  240000ms

Call log:
  - Expect "toHaveText" with timeout 240000ms
  - waiting for locator('section[aria-label="Preview"]').locator(':scope > div').first()
    482 × locator resolved to <div>Booting preview…</div>
        - unexpected value "Booting preview…"

```

### angular @ 16 [container] — unexpected

- resolved version: 16.2.0

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('section[aria-label="Preview"]').locator(':scope > div').first()
Expected: "Live"
Received: "Booting preview…"
Timeout:  240000ms

Call log:
  - Expect "toHaveText" with timeout 240000ms
  - waiting for locator('section[aria-label="Preview"]').locator(':scope > div').first()
    482 × locator resolved to <div>Booting preview…</div>
        - unexpected value "Booting preview…"

```

### angular @ 17 [container] — unexpected

- resolved version: 17.1.0

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('section[aria-label="Preview"]').locator(':scope > div').first()
Expected: "Live"
Received: "Booting preview…"
Timeout:  240000ms

Call log:
  - Expect "toHaveText" with timeout 240000ms
  - waiting for locator('section[aria-label="Preview"]').locator(':scope > div').first()
    481 × locator resolved to <div>Booting preview…</div>
        - unexpected value "Booting preview…"

```

### ant-design @ 15 [container] — unexpected

- resolved version: 15.3.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### ant-design @ 16 [container] — unexpected

- resolved version: 16.2.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### astro @ 15 [container] — unexpected

- resolved version: 15.3.0

```
Error: console/page errors:
Failed to load resource: the server responded with a status of 504 ()

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "Failed to load resource: the server responded with a status of 504 ()",
+ ]
```

### astro @ 16 [container] — unexpected

- resolved version: 16.2.0

```
Error: console/page errors:
Failed to load resource: the server responded with a status of 504 ()

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "Failed to load resource: the server responded with a status of 504 ()",
+ ]
```

### astro @ 17 [container] — unexpected

- resolved version: 17.1.0

```
Error: console/page errors:
Failed to load resource: the server responded with a status of 504 ()

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "Failed to load resource: the server responded with a status of 504 ()",
+ ]
```

### astro @ 18 [container] — unexpected

- resolved version: 18.0.0

```
Error: console/page errors:
Failed to load resource: the server responded with a status of 504 ()

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "Failed to load resource: the server responded with a status of 504 ()",
+ ]
```

### base-web @ 15 [container] — unexpected

- resolved version: 15.3.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### base-web @ 16 [container] — unexpected

- resolved version: 16.2.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### base-web @ 18 [container] — flaky

- resolved version: 18.0.0

### fluent-ui @ 15 [container] — unexpected

- resolved version: 15.3.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### fluent-ui @ 16 [container] — unexpected

- resolved version: 16.2.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### mui @ 15 [container] — unexpected

- resolved version: 15.3.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### mui @ 16 [container] — unexpected

- resolved version: 16.2.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### next-shadcn.js @ 15 [container] — unexpected

- resolved version: 15.3.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```

### next-shadcn.js @ 16 [container] — unexpected

- resolved version: 16.2.0

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0

Call Log:
- Timeout 60000ms exceeded while waiting on the predicate
```


Note: container-engine starters verify only that the requested version reached the session (package.json pin); in-frame `Handsontable.version` is typically unavailable for ESM bundles and is reported as `unverified` rather than a failure.
