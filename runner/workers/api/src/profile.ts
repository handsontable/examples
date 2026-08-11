// Pure profile logic (DEV-2166) — no bindings, no fetch, no Worker globals.
//
// Split out so it can be unit-tested by the repo's existing `node:test` runner
// (`pipeline/*.test.mjs`); there is no worker-level test harness. Keep this file
// free of anything Node can't load under `--experimental-strip-types`: erasable
// TypeScript only (no enums, no namespaces, no parameter properties) and no
// imports beyond `import type`.

/** Upper bound on a stored avatar. 512 KB is ~50× what a 24px round preview
 *  needs; the cap exists to stop an unbounded body being buffered in a Worker,
 *  not to police image quality. */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** Raster only, and deliberately narrower than "any image": GIF is excluded
 *  (animation in a 24px avatar) and SVG is excluded outright — it is a script
 *  surface, and we serve these back from our own origin. */
export type AvatarType = "image/png" | "image/jpeg" | "image/webp";

export const MAX_DISPLAY_NAME = 64;
export const MAX_DESCRIPTION = 280;

/**
 * Identify an upload by its leading bytes.
 *
 * Never trust the request's `Content-Type` for this: it is attacker-controlled,
 * and whatever we conclude here is what we later store as `httpMetadata` and
 * echo back on the public read route. Sniffing is the only reason that echo is
 * safe.
 */
export function sniffImage(bytes: Uint8Array): AvatarType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // WebP: "RIFF" ....(size).... "WEBP". Both halves are required — RIFF alone is
  // a container family (WAV, AVI), so checking only bytes 0-3 would accept audio
  // and hand it back to a browser labelled as an image.
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

/** Size check. Runs twice per upload: once on the declared `Content-Length` so a
 *  huge body is refused before it is buffered, then again on the real byte
 *  length — the header can be absent, or a lie. */
export function checkAvatarSize(byteLength: number): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return { ok: false, error: "empty upload" };
  if (byteLength > MAX_AVATAR_BYTES) {
    return { ok: false, error: `image is larger than ${Math.floor(MAX_AVATAR_BYTES / 1024)} KB` };
  }
  return { ok: true };
}

export interface ProfileDefaults {
  displayName: string;
  avatarUrl: string | null;
  initial: string;
}

/**
 * What to show for a user with no stored profile.
 *
 * `name` and `picture` are Google's OIDC `profile`-scope claims. The broker
 * currently requests `scope=openid email` only, so both are always absent today
 * — this is the seam, not a live path. If the broker ever widens its scope the
 * claims flow through with no further change here.
 */
export function deriveDefaults(identity: { email: string; name?: string; picture?: string }): ProfileDefaults {
  const email = identity.email;
  const localPart = email.split("@")[0] || email;
  const claimed = identity.name?.trim();
  const displayName = claimed || localPart;
  return {
    displayName,
    avatarUrl: identity.picture?.trim() || null,
    initial: (displayName.trim()[0] ?? email.trim()[0] ?? "?").toUpperCase(),
  };
}

export interface ProfileInput {
  display_name: string | null;
  description: string | null;
}

/**
 * Validate and normalise a `PUT /api/profile` body.
 *
 * Empty (or whitespace-only) collapses to NULL rather than `""`, which is what
 * makes "clear the field" mean "go back to the derived default" instead of
 * "show a blank name". Over-length is rejected rather than truncated: silently
 * storing something other than what was typed is worse than a 400 the form can
 * show.
 */
export function normalizeProfileInput(body: unknown): { ok: true; value: ProfileInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }
  const raw = body as Record<string, unknown>;

  const field = (key: string, max: number): { ok: true; value: string | null } | { ok: false; error: string } => {
    const value = raw[key];
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== "string") return { ok: false, error: `${key} must be a string` };
    const trimmed = value.trim();
    if (trimmed.length === 0) return { ok: true, value: null };
    if (trimmed.length > max) return { ok: false, error: `${key} must be ${max} characters or fewer` };
    return { ok: true, value: trimmed };
  };

  const name = field("display_name", MAX_DISPLAY_NAME);
  if (!name.ok) return name;
  const description = field("description", MAX_DESCRIPTION);
  if (!description.ok) return description;

  return { ok: true, value: { display_name: name.value, description: description.value } };
}

/** R2 key for a stored avatar. One flat prefix; demo artifacts all live under
 *  `demos/<id>/` (share.ts), so the two can never collide. */
export function avatarObjectKey(avatarKey: string): string {
  return `avatars/${avatarKey}`;
}

/** Public URL for a stored avatar, relative so it works on every origin the app
 *  is served from (prod, `vite preview`, and the dev server's `/api` proxy). */
export function avatarUrlFor(avatarKey: string): string {
  return `/api/profile/avatar/${avatarKey}`;
}
