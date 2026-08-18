// Server-side Handsontable version resolution and pinning (DEV-2565, ADR-0005).
//
// Before this module the version was free-form metadata at the API boundary and a
// validated ref everywhere downstream: both create routes stored
// `body.htVersion ?? "latest"` without validating it, and `share.ts`'s
// `files // already version-injected` was a promise only the editor kept. A demo
// created over the MCP therefore landed with `ht_version = "latest"` — a string
// `validateHandsontableVersion` rejects — so `/edit/:id` refused to boot, its pin
// no-op stopped normalising the dependency, and a bare PR number reached pnpm as a
// registry range (`ERR_PNPM_NO_MATCHING_VERSION ... handsontable@13106`, Sentry
// DEMOS-1X).
//
// The rule is derive, don't default. A caller that pins a pkg.pr.new build in
// package.json and says nothing about `htVersion` is asking for that build;
// resolving the missing version against npm and rewriting the dependency would
// rebuild its demo against a different core — worse than the bug being fixed. So
// the payload is asked first and npm only when nothing else answers.

import {
  DEFAULT_MAX_MAJOR,
  DEFAULT_MIN_MAJOR,
  handsontableDependencyRef,
  pickLatestNextVersion,
  pinHandsontableFiles,
  validateHandsontableVersion,
} from "@handsontable/demo-runtime";
import type { Env } from "./env.js";

/** npm dist-tags the API accepts as input but never stores: they name a moving
 *  target, and the column has to hold a ref the editor can validate. */
const DIST_TAGS = new Set(["latest", "next"]);

const CATALOG_KEY = "versions";
const CATALOG_TTL = 3600;
/**
 * The last `latest` npm was known to have, kept far longer than the catalog.
 *
 * Resolving a dist-tag server-side made npm availability a dependency of demo
 * *creation*, where before it only degraded the version dropdown (review of PR
 * #230). A payload that carries nothing but ranges — the shape hot-mcp asks the
 * model for — would otherwise 502 on a registry hiccup, and reach an MCP caller
 * as "the runner refused your demo". A month-old `latest` is a far better answer
 * than a refusal: it is a real published version, so the demo builds, and the
 * only cost of it being stale is a demo pinned one release behind.
 */
const LAST_GOOD_LATEST_KEY = "versions:last-good-latest";
const LAST_GOOD_LATEST_TTL = 30 * 24 * 3600;

export interface VersionCatalog {
  latest: string | null;
  next: string | null;
  versions: string[];
}

/**
 * The published-version catalog behind `GET /api/versions`, KV-cached for an hour.
 * Shared with the version resolution below so a dist-tag resolves through exactly
 * the picker's own view of npm. Throws when the registry is unreachable.
 */
export async function fetchVersionCatalog(env: Env): Promise<VersionCatalog> {
  const cached = (await env.CACHE.get(CATALOG_KEY, "json")) as VersionCatalog | null;
  // `cached.latest`, not just `cached`: before DEV-2565 this catalog was written
  // unconditionally, so an npm error body parsed as `{latest:null}` is sitting in
  // KV under this key today and outlives the deploy. Returning one now would 502
  // every create that falls through to npm latest until its TTL ran out.
  if (cached?.latest) return cached;

  const r = await fetch("https://registry.npmjs.org/handsontable");
  // Checked before anything is cached: an error body parses fine as JSON and
  // would otherwise be stored as an empty catalog for the whole TTL. That used to
  // degrade only the version dropdown; since this module gates demo creation it
  // would 502 every create that falls through to npm latest for an hour.
  if (!r.ok) throw new Error(`npm registry answered ${r.status} for handsontable`);
  const j = (await r.json()) as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, unknown>;
    time?: Record<string, string>;
  };
  const latest = j["dist-tags"]?.latest ?? null;
  // Newest -next build by publish date — the `next` dist-tag went stale
  // (2026-02-19) while nightlies kept publishing, and serving it here re-pinned
  // docs examples onto a five-month-old core. The tag is only a fallback for a
  // registry document without `time`.
  const next = pickLatestNextVersion(j.time) ?? j["dist-tags"]?.next ?? null;
  const cmp = (a: string, b: string) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) { const d = (pb[i] ?? 0) - (pa[i] ?? 0); if (d) return d; }
    return 0;
  };
  const versions = Object.keys(j.versions ?? {})
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .filter((v) => { const m = Number(v.split(".")[0]); return m >= DEFAULT_MIN_MAJOR && m <= DEFAULT_MAX_MAJOR; })
    .sort(cmp)
    .slice(0, 15);

  const payload: VersionCatalog = { latest, next, versions };
  // Returned either way — `GET /api/versions` keeps answering with whatever npm
  // gave, and the picker degrades onto its hardcoded list on its own — but a
  // document that answers no version question is not worth an hour of KV.
  if (latest) {
    await env.CACHE.put(CATALOG_KEY, JSON.stringify(payload), { expirationTtl: CATALOG_TTL });
    await env.CACHE.put(LAST_GOOD_LATEST_KEY, latest, { expirationTtl: LAST_GOOD_LATEST_TTL });
  }
  return payload;
}

export type ResolvedVersion =
  | { ok: true; ref: string; files: Record<string, string> }
  | { ok: false; status: number; message: string };

export interface ResolveArgs {
  /** What the caller asked for, if anything. A dist-tag is resolved, not stored. */
  htVersion?: string;
  /** The submitted workspace. Returned pinned to the resolved ref. */
  files: Record<string, string>;
  /** The demo's current ref, on a rebuild — used only when the payload is silent. */
  previousRef?: string | null;
  /**
   * Treat an explicit dist-tag as the caller's intent, outranking the payload's own
   * pin. True on the service path (`/api/mcp/demos`) only: hot-mcp passes through
   * what the model asked for and never a stored `ht_version`, so a tag there is a
   * fresh request — and without this a machine caller has no way to move a demo off
   * a PR build. The browser paths keep the tag demoted, because `MyDemos`'s fork
   * used to forward a legacy row's sentinel and a cached build still can.
   */
  trustDistTag?: boolean;
}

/** Resolve one dist-tag through the catalog, or say why it could not be. */
async function resolveDistTag(env: Env, tag: string): Promise<{ ok: true; ref: string } | { ok: false; status: number; message: string }> {
  let catalog: VersionCatalog | null = null;
  let reason = "";
  try {
    catalog = await fetchVersionCatalog(env);
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }
  const ref = catalog ? (tag === "next" ? catalog.next : catalog.latest) : null;
  if (ref) return { ok: true, ref };

  // npm is unreachable or answered with no such tag. For `latest` that is not the
  // caller's problem and not worth refusing a build over: fall back to the last
  // one we saw. `next` has no equivalent — a stale nightly is a specific build
  // nobody asked for, where a stale `latest` is just a release behind.
  if (tag === "latest") {
    const remembered = await env.CACHE.get(LAST_GOOD_LATEST_KEY, "text");
    if (remembered) return { ok: true, ref: remembered };
  }
  return {
    ok: false,
    status: 502,
    message: reason
      ? `could not reach the npm registry to resolve handsontable@${tag}: ${reason}`
      : `npm has no handsontable@${tag} to resolve`,
  };
}

/**
 * Decide the ref a create/rebuild is for, and return the file map pinned to it.
 *
 * Order: a concrete ref the caller asked for, then — on the service path only
 * (`trustDistTag`) — an explicit dist-tag, then what the payload's package.json
 * already pins, then a dist-tag from a browser caller, then the demo's current
 * ref, then npm `latest`. Only an explicit unusable `htVersion`
 * is refused — with the validator's own message, and before the caller spends a
 * builder container on a doomed install.
 */
export async function resolveHandsontableVersion(env: Env, args: ResolveArgs): Promise<ResolvedVersion> {
  const explicit = args.htVersion?.trim();
  // A dist-tag is not an answer, it is a deferral: it names whatever npm has
  // today, exactly as a range does. `MyDemos`'s fork forwards the row's
  // `ht_version` verbatim, so legacy demos arrive here asking for "latest" while
  // their package.json pins a PR build — and rewriting that would fork the demo
  // onto a different core. So a tag ranks below the payload's own pin.
  const tag = explicit && DIST_TAGS.has(explicit.toLowerCase()) ? explicit.toLowerCase() : null;
  let ref: string | null = null;

  if (explicit && !tag) {
    const validated = validateHandsontableVersion(explicit);
    if (!validated.ok) return { ok: false, status: 400, message: validated.message };
    ref = validated.value.ref;
  }

  if (tag && args.trustDistTag) {
    const tagged = await resolveDistTag(env, tag);
    if (!tagged.ok) return tagged;
    ref = tagged.ref;
  }

  ref ??= handsontableDependencyRef(args.files);

  if (ref === null && tag) {
    const tagged = await resolveDistTag(env, tag);
    if (!tagged.ok) return tagged;
    ref = tagged.ref;
  }

  if (ref === null && args.previousRef) {
    // Legacy rows hold the "latest" sentinel, so the stored value is a candidate,
    // never an authority.
    const previous = validateHandsontableVersion(args.previousRef);
    if (previous.ok) ref = previous.value.ref;
  }

  if (ref === null) {
    const tagged = await resolveDistTag(env, "latest");
    if (!tagged.ok) return tagged;
    ref = tagged.ref;
  }

  // One normalisation point for every branch above: turns "13106" back into a
  // pkg.pr.new build and "17.6" into 17.6.0, which is what the pin needs.
  const version = validateHandsontableVersion(ref);
  if (!version.ok) return { ok: false, status: 400, message: version.message };

  return { ok: true, ref: version.value.ref, files: pinHandsontableFiles(args.files, version.value) };
}

/**
 * The ref to hand the editor for a stored demo: the column when it holds one the
 * validator accepts, otherwise whatever the snapshot itself pins.
 *
 * Repairs demos saved before this fix without a batch job. The editor adopts
 * whatever it is told as its version state and suppresses its own latest-fallback
 * (`hadUrlVersion`), so a sentinel there is a boot refusal; and the snapshot is
 * the only place that still knows what the demo was built against. Null means
 * "nothing to say" — the editor then resolves npm latest as it does for a fresh
 * playground.
 */
export function editorVersionRef(storedRef: string | null | undefined, files: Record<string, string>): string | null {
  if (storedRef) {
    const stored = validateHandsontableVersion(storedRef);
    if (stored.ok) return stored.value.ref;
  }
  return handsontableDependencyRef(files);
}
