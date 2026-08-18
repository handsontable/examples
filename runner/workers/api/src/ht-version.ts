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
  if (cached) return cached;

  const r = await fetch("https://registry.npmjs.org/handsontable");
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
  await env.CACHE.put(CATALOG_KEY, JSON.stringify(payload), { expirationTtl: CATALOG_TTL });
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
}

/** Resolve one dist-tag through the catalog, or say why it could not be. */
async function resolveDistTag(env: Env, tag: string): Promise<{ ok: true; ref: string } | { ok: false; status: number; message: string }> {
  let catalog: VersionCatalog;
  try {
    catalog = await fetchVersionCatalog(env);
  } catch (e) {
    return {
      ok: false,
      status: 502,
      message: `could not reach the npm registry to resolve handsontable@${tag}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const ref = tag === "next" ? catalog.next : catalog.latest;
  // A registry document with no usable tag is the registry's problem, not the
  // caller's — and storing the tag itself is the defect this module exists for.
  if (!ref) return { ok: false, status: 502, message: `npm has no handsontable@${tag} to resolve` };
  return { ok: true, ref };
}

/**
 * Decide the ref a create/rebuild is for, and return the file map pinned to it.
 *
 * Order: what the caller asked for, then what the payload's package.json already
 * pins, then the demo's current ref, then npm `latest`. Only an explicit
 * unusable `htVersion` is refused — with the validator's own message, and before
 * the caller spends a builder container on a doomed install.
 */
export async function resolveHandsontableVersion(env: Env, args: ResolveArgs): Promise<ResolvedVersion> {
  const explicit = args.htVersion?.trim();
  let ref: string | null = null;

  if (explicit) {
    if (DIST_TAGS.has(explicit.toLowerCase())) {
      const tagged = await resolveDistTag(env, explicit.toLowerCase());
      if (!tagged.ok) return tagged;
      ref = tagged.ref;
    } else {
      const validated = validateHandsontableVersion(explicit);
      if (!validated.ok) return { ok: false, status: 400, message: validated.message };
      ref = validated.value.ref;
    }
  }

  ref ??= handsontableDependencyRef(args.files);

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
