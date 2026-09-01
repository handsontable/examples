// How a Tier-2 session-start duration is bucketed for its Sentry tag (DEV-2559).
//
// Dependency-free on purpose, and in `apps/authoring` rather than in the runtime
// package — the same arrangement, for the same reason, as `reportingGate.ts` (see the
// note at the top of that file). `App.tsx` cannot be unit-tested at all: it imports
// `@sentry/react` and reads `import.meta.env`, neither of which node resolves. Pulling
// the one piece of arithmetic worth pinning into a module `pipeline/*.test.mjs` can
// import under `--experimental-strip-types` is what buys it coverage, and it buys that
// without adding a temporary diagnostic to the runtime package's published .d.ts.
// Do not let this file grow imports.
//
// WHY A BUCKET AND NOT THE RAW NUMBER. The question DEMOS-9 poses is whether the
// failures cluster at one duration — a fixed ceiling above our Worker, which is a
// platform/timeout fix — or spread out, which means container starts that are honestly
// too slow and is a boot fix. A ceiling produces values that are close but never equal,
// so a raw-ms tag would facet into ~83 singletons and hide the very cluster being
// looked for. The exact millisecond count still travels, as `extra.sessionElapsedMs`.
//
// The upper boundaries below (in seconds) are a first guess aimed at Cloudflare's known
// ~100s edge behaviour. If a day of data piles into one bucket, split THAT bucket —
// switching to raw ms would only reintroduce the problem this exists to avoid.
const BOUNDARIES_S = [1, 5, 15, 30, 60, 100, 120];

/** `"<Ns"` for the first boundary N the duration falls under, else `">=120s"`.
 *  A label means strictly "ms < N × 1000". */
export function elapsedBucket(ms: number): string {
  for (const s of BOUNDARIES_S) {
    if (ms < s * 1000) return `<${s}s`;
  }
  return `>=${BOUNDARIES_S[BOUNDARIES_S.length - 1]}s`;
}

// `session_response_origin` — the DEMOS-9 facet answering "where did this response
// come from", in one click instead of a manual header read per event.
//
// Dependency-free and structurally typed (takes the three fields it needs rather
// than importing `SessionStartDiagnostics`) for the same reason `elapsedBucket`
// lives here rather than in `App.tsx`: this file is the one piece of the
// diagnostics pipeline `pipeline/*.test.mjs` can import under
// `--experimental-strip-types`, because `App.tsx` itself cannot be unit-tested at
// all (it imports `@sentry/react` and reads `import.meta.env`).
//
//   ray present                     -> "cloudflare"  (came through our edge; the
//                                                       interception theory is
//                                                       refuted for this event)
//   !ray && !headersReadable        -> "unreadable"  (absence proves nothing —
//                                                       cross-origin dev, cors()
//                                                       exposes no headers)
//   !ray && headersReadable && n==0 -> "headerless"  (same-origin and not one
//                                                       readable header: synthetic)
//   !ray && headersReadable && n>0  -> "foreign"     (headers we can read, and no
//                                                       edge id among them)
export function responseOrigin(edge: {
  readonly ray: string | null;
  readonly headersReadable: boolean;
  readonly headerNames: readonly string[];
}): "cloudflare" | "unreadable" | "headerless" | "foreign" {
  if (edge.ray) return "cloudflare";
  if (!edge.headersReadable) return "unreadable";
  return edge.headerNames.length === 0 ? "headerless" : "foreign";
}
