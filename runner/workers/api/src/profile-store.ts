// D1 + R2 access for the user profile (DEV-2166). The decisions live in
// `profile.ts` (pure, unit-tested); this file only moves bytes.
//
// Every statement here binds `email` from the caller's verified identity, and
// no route accepts an email as input — so "a caller cannot read or write
// another user's profile" is a property of the shape of these functions, not a
// check that could be forgotten.

import type { Env } from "./env.js";
import type { Identity } from "./auth.js";
import {
  avatarObjectKey,
  avatarUrlFor,
  deriveDefaults,
  type AvatarType,
  type ProfileInput,
} from "./profile.js";

export interface ProfileRow {
  email: string;
  display_name: string | null;
  description: string | null;
  avatar_key: string | null;
  created_at: string;
  updated_at: string;
}

/** What `GET /api/profile` returns, and what the client renders from.
 *
 *  `display_name` is always a string: the caller should never have to know
 *  whether it came from the row or from the email. `saved_name` says which,
 *  because the Settings form has to show an empty field for "not set" rather
 *  than pre-filling the derived default and making it look stored. */
export interface ProfileView {
  email: string;
  display_name: string;
  saved_name: string | null;
  description: string | null;
  avatar_url: string | null;
  initial: string;
}

export async function getProfileRow(env: Env, email: string): Promise<ProfileRow | null> {
  const row = await env.DB.prepare(
    "SELECT email,display_name,description,avatar_key,created_at,updated_at FROM profiles WHERE email = ?",
  ).bind(email).first<ProfileRow>();
  return row ?? null;
}

/** Merge the stored row (if any) over the identity-derived defaults. A stored
 *  value always wins and is never re-overwritten from the identity. */
export function toView(identity: Identity, row: ProfileRow | null): ProfileView {
  const defaults = deriveDefaults(identity);
  const displayName = row?.display_name ?? defaults.displayName;
  return {
    email: identity.email,
    display_name: displayName,
    saved_name: row?.display_name ?? null,
    description: row?.description ?? null,
    // No default picture exists — an uploaded avatar or nothing, in which case
    // the client draws the monogram from `initial` (ADR-0007).
    avatar_url: row?.avatar_key ? avatarUrlFor(row.avatar_key) : null,
    initial: (displayName.trim()[0] ?? "?").toUpperCase(),
  };
}

export async function readProfile(env: Env, identity: Identity): Promise<ProfileView> {
  return toView(identity, await getProfileRow(env, identity.email));
}

/** Upsert name + description, leaving `avatar_key` alone — the avatar is its own
 *  pair of endpoints and must not be cleared by a text save. */
export async function saveProfile(env: Env, identity: Identity, input: ProfileInput, now: string): Promise<ProfileView> {
  await env.DB.prepare(
    `INSERT INTO profiles (email, display_name, description, avatar_key, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name,
                                      description  = excluded.description,
                                      updated_at   = excluded.updated_at`,
  ).bind(identity.email, input.display_name, input.description, now, now).run();
  return readProfile(env, identity);
}

/**
 * Store a new avatar and drop the one it replaces.
 *
 * Order matters: write the new object, point the row at it, then delete the old
 * object. Any failure mid-way leaves an orphaned object rather than a row whose
 * `avatar_key` names something that isn't there — one is invisible waste, the
 * other is a broken image on every surface. Nothing garbage-collects `avatars/`
 * (the nightly R2 sweep in reconcile.ts only walks demo prefixes), so the delete
 * here is the only thing keeping re-uploads from accumulating.
 */
export async function putAvatar(
  env: Env,
  identity: Identity,
  bytes: ArrayBuffer,
  contentType: AvatarType,
  now: string,
): Promise<ProfileView> {
  const previous = await getProfileRow(env, identity.email);
  const key = crypto.randomUUID();

  await env.ARTIFACTS.put(avatarObjectKey(key), bytes, { httpMetadata: { contentType } });

  await env.DB.prepare(
    `INSERT INTO profiles (email, display_name, description, avatar_key, created_at, updated_at)
     VALUES (?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET avatar_key = excluded.avatar_key,
                                      updated_at = excluded.updated_at`,
  ).bind(identity.email, key, now, now).run();

  if (previous?.avatar_key) {
    await env.ARTIFACTS.delete(avatarObjectKey(previous.avatar_key)).catch(() => {
      /* orphan, not a failure — the new avatar is already live */
    });
  }

  return readProfile(env, identity);
}

/** Clear the avatar and delete its object; the client falls back to the
 *  monogram. A no-op when there was none. */
export async function removeAvatar(env: Env, identity: Identity, now: string): Promise<ProfileView> {
  const previous = await getProfileRow(env, identity.email);
  if (previous?.avatar_key) {
    await env.DB.prepare("UPDATE profiles SET avatar_key = NULL, updated_at = ? WHERE email = ?")
      .bind(now, identity.email).run();
    await env.ARTIFACTS.delete(avatarObjectKey(previous.avatar_key)).catch(() => {
      /* the row no longer references it; a leftover object is harmless */
    });
  }
  return readProfile(env, identity);
}

/**
 * Serve a stored avatar. Public by design — it is referenced by `<img src>` from
 * pages that may not carry the caller's token — which is exactly why the key is
 * an opaque uuid and not the email.
 *
 * The content type comes from what we sniffed at upload and wrote to
 * `httpMetadata`, never from anything the reader or the uploader said. A fresh
 * key per upload makes the URL content-addressed enough to cache forever.
 */
export async function serveAvatar(env: Env, avatarKey: string): Promise<Response> {
  const obj = await env.ARTIFACTS.get(avatarObjectKey(avatarKey));
  if (!obj) return new Response("Not found", { status: 404 });
  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      // These are user-uploaded bytes served from our own origin. Even with the
      // sniff allowlist, tell the browser not to second-guess the type.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
