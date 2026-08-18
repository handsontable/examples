// Version dispatch — the package.json dependency-rewrite logic that used to live
// in the former render-ms service (validate-handsontable-version.js,
// pkg-pr-new.js), so the runner accepts the same `handsontable-version` inputs.
//
// Rule: rewrite every dependency whose package name
// contains "handsontable" EXCEPT `@handsontable/pikaday` to the requested
// version (or a pkg.pr.new URL). This pins core `handsontable` and its framework
// wrapper in lockstep. Supported Handsontable major range: 15-19.
//
// Upstream `pikaday` — which the docs Pikaday recipe uses on every docs branch
// after DEV-2180 — needs no entry here: its name does not contain "handsontable",
// so it is left alone by the rule above. The fork entry only has to outlive the
// docs-examples buckets that still import it, i.e. until every bucket has been
// re-imported from a branch carrying that change.

import semver from "semver";
import type { FilesMap, HandsontableVersionRef } from "./types.js";

export const DEFAULT_MAX_MAJOR = 19;
// Empirically verified range is 15-19 (DEV-2102 / ADR-0021 decision 10); majors
// below 15 have never been tested against current starters/wrappers and stay
// out of scope. Previously only the UI-facing GET /api/versions listing
// enforced this floor — a direct session/API call bypassing the version
// dropdown could still request an untested major like 14.
export const DEFAULT_MIN_MAJOR = 15;
const MIN_BARE_NUMERIC_PKG_PR_NEW_REF = 1000;
// Prerelease build published under the npm `next` dist-tag, e.g.
// "0.0.0-next-64139ae-20260219" (commit hash + build date). Its major is
// always 0 under plain semver parsing, so it must bypass the major-range
// check below rather than being rejected as "major must be at least 15".
const NEXT_PRERELEASE_RE = /^0\.0\.0-next-[0-9a-f]+-\d{8}$/i;

/**
 * Dependency never rewritten: an independently versioned Handsontable plugin.
 * Legacy — docs examples moved to upstream `pikaday`, which needs no exemption.
 * Removable once no bucket under apps/authoring/public/docs-examples/ imports
 * the fork (`grep -rl "@handsontable/pikaday"` there).
 */
const NEVER_REWRITE = new Set(["@handsontable/pikaday"]);

export function pkgPrNewDependencyUrl(packageName: string, buildRef: string): string {
  return `https://pkg.pr.new/${packageName}@${buildRef}`;
}

/** True for an npm `next`-dist-tag prerelease build, e.g. "0.0.0-next-<hash>-<date>". */
export function isNextPrereleaseVersion(value: string): boolean {
  return NEXT_PRERELEASE_RE.test(value);
}

/** Matches nightly (`0.0.0-next-<hash>-<date>`) and dotted (`19.0.0-next.1`) prereleases. */
const ANY_NEXT_VERSION_RE = /^\d+\.\d+\.\d+-next[.-]/;

/**
 * Newest `-next` version by npm publish date, from a registry document's
 * `time` map — or null when none exists. The `next` dist-tag is deliberately
 * not consulted: it went stale on 2026-02-19 while nightlies kept publishing,
 * silently pinning docs examples to a five-month-old build. A string or
 * semver-prerelease sort would not do either — the nightly hash sits in the
 * prerelease identifier, so an old build can sort above newer ones. (The
 * docs importer applies the same rule in pipeline/docs-import-config.mjs.)
 */
export function pickLatestNextVersion(time: Record<string, string> | undefined): string | null {
  let newest: { version: string; publishedAt: number } | null = null;
  for (const [version, published] of Object.entries(time ?? {})) {
    if (!ANY_NEXT_VERSION_RE.test(version)) continue; // skips created/modified/stable
    const publishedAt = Date.parse(published);
    if (Number.isNaN(publishedAt)) continue;
    if (!newest || publishedAt > newest.publishedAt) newest = { version, publishedAt };
  }
  return newest?.version ?? null;
}

/** Parse a full https://pkg.pr.new/...@ref URL; bare numeric ids handled in validation. */
export function parsePkgPrNewFromUrl(value: string): string | null {
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== "https:" || u.hostname !== "pkg.pr.new") return null;
    const p = u.pathname.replace(/^\//, "");
    const at = p.lastIndexOf("@");
    if (at <= 0) return null;
    const ref = p.slice(at + 1);
    return ref === "" ? null : ref;
  } catch {
    return null;
  }
}

function expandPartialNumericSemver(s: string): string | null {
  if (!/^\d+(?:\.\d+)+$/.test(s)) return null;
  const parts = s.split(".");
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  const major = nums[0] ?? 0;
  const minor = nums[1] ?? 0;
  const patch = nums[2] ?? 0;
  if (![major, minor, patch].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return `${major}.${minor}.${patch}`;
}

export type ValidationResult =
  | { ok: true; value: HandsontableVersionRef }
  | { ok: false; message: string };

/**
 * Validate a `handsontable-version` input: semver (loose, npm-style partials like
 * "17.0"), a bare pkg.pr.new numeric id, or a https://pkg.pr.new/... URL. Enforces
 * major <= maxMajor for real semver.
 */
export function validateHandsontableVersion(
  value: unknown,
  maxMajor: number = DEFAULT_MAX_MAJOR,
  minMajor: number = DEFAULT_MIN_MAJOR,
): ValidationResult {
  if (value === undefined || value === null) {
    return { ok: false, message: "handsontable-version is required" };
  }
  const trimmed = String(value).trim();
  if (trimmed === "") return { ok: false, message: "handsontable-version cannot be empty" };

  const urlRef = parsePkgPrNewFromUrl(trimmed);
  if (urlRef !== null) return { ok: true, value: { ref: urlRef, pkgPrNew: true } };

  if (isNextPrereleaseVersion(trimmed)) return { ok: true, value: { ref: trimmed, pkgPrNew: false } };

  const rangeMsg = (normalized: string) => {
    const major = semver.major(normalized);
    if (major > maxMajor) return `handsontable-version major must be at most ${maxMajor}; got ${major}`;
    if (major < minMajor) return `handsontable-version major must be at least ${minMajor}; got ${major}`;
    return null;
  };

  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(n) || n < 0) {
      return { ok: false, message: `handsontable-version is not a valid numeric id` };
    }
    if (n > maxMajor) {
      if (n < MIN_BARE_NUMERIC_PKG_PR_NEW_REF) {
        return { ok: false, message: `handsontable-version major must be at most ${maxMajor}` };
      }
      return { ok: true, value: { ref: trimmed, pkgPrNew: true } };
    }
    const coerced = semver.coerce(trimmed);
    const normalized = coerced ? semver.valid(coerced.version, { loose: true }) : null;
    if (!normalized) return { ok: false, message: `handsontable-version could not be interpreted as semver` };
    const err = rangeMsg(normalized);
    return err ? { ok: false, message: err } : { ok: true, value: { ref: normalized, pkgPrNew: false } };
  }

  let normalized = semver.valid(trimmed, { loose: true });
  if (!normalized) {
    const expanded = expandPartialNumericSemver(trimmed);
    if (expanded) normalized = semver.valid(expanded, { loose: true });
  }
  if (!normalized) {
    return { ok: false, message: `handsontable-version must be semver-valid or a pkg.pr.new id/URL` };
  }
  const err = rangeMsg(normalized);
  return err ? { ok: false, message: err } : { ok: true, value: { ref: normalized, pkgPrNew: false } };
}

/** True if `name` is a Handsontable package that should be version-pinned. */
export function isHandsontablePackage(name: string): boolean {
  return name.includes("handsontable") && !NEVER_REWRITE.has(name);
}

/**
 * The ref a file map already asks for, or null when its package.json does not
 * name one — a range (`^18.0.0`), a dist-tag, an unparseable file, or no
 * Handsontable dependency at all.
 *
 * DEV-2565: this is what lets the API derive a version from the payload instead
 * of defaulting to the `latest` sentinel. An agent that pins a PR build in
 * package.json and says nothing about `htVersion` is asking for that build, so
 * resolving the missing version against npm would silently rebuild its demo
 * against a different core. Deriving keeps the caller's intent.
 */
export function handsontableDependencyRef(files: FilesMap, pkgPath = "/package.json"): string | null {
  const raw = files[pkgPath];
  if (raw === undefined) return null;

  let deps: Record<string, string> | undefined;
  try {
    deps = (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies;
  } catch {
    return null;
  }
  if (!deps) return null;

  // Core first; a wrapper-only workspace (no `handsontable` entry) still pins in
  // lockstep, so any rewritable Handsontable dep answers the same question.
  const value = deps["handsontable"]
    ?? Object.entries(deps).find(([name]) => isHandsontablePackage(name))?.[1];
  if (typeof value !== "string" || value.trim() === "") return null;

  const urlRef = parsePkgPrNewFromUrl(value);
  if (urlRef !== null) return urlRef;

  // Only a value that names one build counts. Ranges and dist-tags say "whatever
  // npm has", so they carry no ref to preserve — and neither does a *partial*
  // version, which npm reads as a range too: "18" is any 18.x, so deriving
  // 18.0.0 from it would pin the demo below what npm would have installed.
  // `validateHandsontableVersion` coerces partials, so the shape is checked here
  // rather than delegated to it.
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    // A bare integer is either a pkg.pr.new id or a major-only range; the
    // validator's own threshold is what tells them apart, and only the id names a
    // build. This is the hand-typed PR number from DEMOS-1X.
    const numeric = validateHandsontableVersion(trimmed);
    return numeric.ok && numeric.value.pkgPrNew ? numeric.value.ref : null;
  }

  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(trimmed)) return null;
  const validated = validateHandsontableVersion(trimmed);
  return validated.ok ? validated.value.ref : null;
}

/**
 * Pin a whole file map to `version`: the Handsontable dependencies plus the
 * legacy stylesheet shim. The one implementation shared by the editor
 * (apps/authoring) and the API worker (DEV-2565) — before the worker pinned,
 * `share.ts`'s `files // already version-injected` was a promise only the
 * browser kept, so an agent-supplied package.json installed exactly as written.
 *
 * Idempotent: the rewrite never reads the incoming dependency value, so a map
 * that is already pinned to `version` is a fixed point.
 */
export function pinHandsontableFiles(files: FilesMap, version: HandsontableVersionRef): FilesMap {
  if (files["/package.json"] === undefined) return files;
  try {
    return applyHandsontableCss(applyHandsontableVersion(files, version), version);
  } catch {
    // Only an unparseable package.json reaches here. Leaving it alone hands the
    // failure to the install, which names the file and the syntax error.
    return files;
  }
}

/**
 * Return a new FilesMap with package.json's Handsontable deps pinned to `version`.
 * Pure: does not mutate the input. Throws if package.json is missing/unparseable.
 */
export function applyHandsontableVersion(
  files: FilesMap,
  version: HandsontableVersionRef,
  pkgPath = "/package.json",
): FilesMap {
  const raw = files[pkgPath];
  if (raw === undefined) throw new Error(`applyHandsontableVersion: ${pkgPath} not found`);

  let pkg: { dependencies?: Record<string, string>; [k: string]: unknown };
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`applyHandsontableVersion: ${pkgPath} is not valid JSON: ${(e as Error).message}`);
  }

  const rewrite = (deps: Record<string, string> | undefined) => {
    if (!deps) return deps;
    return Object.fromEntries(
      Object.entries(deps).map(([name, range]) =>
        isHandsontablePackage(name)
          ? [name, version.pkgPrNew ? pkgPrNewDependencyUrl(name, version.ref) : version.ref]
          : [name, range],
      ),
    );
  };

  const next = {
    ...pkg,
    dependencies: rewrite(pkg.dependencies),
  };

  return { ...files, [pkgPath]: JSON.stringify(next, null, 2) + "\n" };
}

/**
 * Major of a concrete Handsontable release, or null when the ref is not one.
 *
 * `-next` builds are the reason this exists: `0.0.0-next-<hash>-<date>` parses
 * as major 0 under plain semver while actually being a post-18 nightly, so any
 * `major <= N` comparison silently classifies the newest core as the oldest.
 * Null means "not a release we can compare" — callers must not treat it as 0.
 * Mirrors the App-side `releaseMajor` helper.
 */
function releaseMajor(ref: string): number | null {
  const trimmed = ref.trim();
  if (ANY_NEXT_VERSION_RE.test(trimmed)) return null;
  const expanded = /^\d+$/.test(trimmed) ? `${trimmed}.0.0` : expandPartialNumericSemver(trimmed);
  const normalized = semver.valid(trimmed, { loose: true })
    ?? (expanded ? semver.valid(expanded, { loose: true }) : null);
  return normalized ? semver.major(normalized) : null;
}

/** The whole `<link>` tag, with its indentation and trailing newline when it owns a line. */
const LEGACY_CSS_LINK_RE = /[ \t]*<link\b[^>]*handsontable\.full\.min\.css[^>]*>[ \t]*\r?\n?/gi;
/** Just the version segment of that URL, for the <=16 rewrite path. */
const LEGACY_CSS_VERSION_RE = /(unpkg\.com\/handsontable@)[^/]+(\/dist\/handsontable\.full\.min\.css)/g;
/** Last major that published `dist/handsontable.full.min.css`; 17.0 removed it. */
const LEGACY_CSS_MAX_MAJOR = 16;

/**
 * Migration shim for artifacts generated before DEV-2207 — nothing emits a
 * Handsontable stylesheet any more, so this is dead weight on fresh artifacts
 * and only fires on saved demos, whose files are replayed verbatim from R2.
 *
 * Those artifacts baked `unpkg.com/handsontable@<v>/dist/handsontable.full.min.css`
 * into their HTML. That path was removed at 17.0.0, and from 17.0.0 core injects
 * its own core stylesheet and applies `mainTheme` when `theme` is undefined, so
 * the link is both dead and unnecessary there — drop it. At <=16 there is no
 * auto-injection and no `ht-theme-*` class for the modern class-scoped
 * stylesheets to attach to, and the legacy file is still published, so it stays
 * as the only thing that styles the grid: rewrite its version segment instead.
 *
 * Pure: does not mutate the input. pkg.pr.new builds are not on unpkg at all.
 */
export function applyHandsontableCss(
  files: FilesMap,
  version: HandsontableVersionRef,
): FilesMap {
  if (version.pkgPrNew) return files;

  const htmlPath = files["/index.html"] !== undefined
    ? "/index.html"
    : files["/src/index.html"] !== undefined
      ? "/src/index.html"
      : null;
  if (!htmlPath) return files;

  const raw = files[htmlPath];
  if (raw === undefined) return files;

  const major = releaseMajor(version.ref);
  // `major === null` (a -next nightly) takes the removal path: those builds are
  // post-18, never legacy-CSS-era. Falling through to the rewrite would re-pin
  // the dead URL onto the newest core.
  const next = major !== null && major <= LEGACY_CSS_MAX_MAJOR
    ? raw.replace(
      LEGACY_CSS_VERSION_RE,
      (_, prefix: string, suffix: string) => `${prefix}${version.ref}${suffix}`,
    )
    : raw.replace(LEGACY_CSS_LINK_RE, "");

  return next === raw ? files : { ...files, [htmlPath]: next };
}
