// Profile validation rules (DEV-2166).
//
// These import the Worker's TypeScript source directly rather than a build:
// there is no worker-level test harness in this repo (no vitest, no miniflare),
// and `profile.ts` is deliberately free of bindings and of non-erasable syntax
// so `--experimental-strip-types` can load it. Everything that touches D1 or R2
// lives in `profile-store.ts` and is covered end-to-end by the Playwright spec.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AVATAR_BYTES,
  avatarUrlFor,
  checkAvatarSize,
  deriveDefaults,
  displayNameFromEmail,
  normalizeProfileInput,
  sniffImage,
} from "../workers/api/src/profile.ts";
import {
  displayNameFromEmail as clientDisplayNameFromEmail,
  initialFromEmail as clientInitialFromEmail,
} from "../apps/authoring/src/displayName.ts";

const bytes = (...values) => new Uint8Array(values);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);

test("sniffImage accepts the three raster formats we serve back", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(WEBP), "image/webp");
});

test("sniffImage rejects a RIFF container that is not WebP", () => {
  // "RIFF....WAVE" — passes a bytes-0-3-only check, and would then be served
  // back to a browser labelled image/webp.
  const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
  assert.equal(sniffImage(wav), null);
});

test("sniffImage rejects SVG, GIF, text and truncated bodies", () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  const gif = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00);
  assert.equal(sniffImage(svg), null, "SVG is a script surface, not an avatar");
  assert.equal(sniffImage(gif), null, "GIF is excluded deliberately");
  assert.equal(sniffImage(new TextEncoder().encode("not an image at all")), null);
  assert.equal(sniffImage(bytes()), null);
  // A correct PNG prefix that stops short of the full 8-byte signature.
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47)), null);
});

test("checkAvatarSize rejects empty and over-cap, accepts the boundary", () => {
  assert.equal(checkAvatarSize(0).ok, false);
  assert.equal(checkAvatarSize(-1).ok, false);
  assert.equal(checkAvatarSize(Number.NaN).ok, false);
  assert.equal(checkAvatarSize(1).ok, true);
  assert.equal(checkAvatarSize(MAX_AVATAR_BYTES).ok, true, "the cap itself is allowed");
  assert.equal(checkAvatarSize(MAX_AVATAR_BYTES + 1).ok, false);
});

test("normalizeProfileInput trims, and maps an emptied field to null", () => {
  const result = normalizeProfileInput({ display_name: "  Ada Lovelace  ", description: "   " });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { display_name: "Ada Lovelace", description: null });
});

test("normalizeProfileInput treats absent and null alike — both clear to the default", () => {
  assert.deepEqual(normalizeProfileInput({}).value, { display_name: null, description: null });
  assert.deepEqual(
    normalizeProfileInput({ display_name: null, description: null }).value,
    { display_name: null, description: null },
  );
});

test("normalizeProfileInput rejects over-length rather than truncating", () => {
  const long = normalizeProfileInput({ display_name: "x".repeat(65) });
  assert.equal(long.ok, false);
  assert.match(long.error, /64 characters/);

  const longDescription = normalizeProfileInput({ description: "x".repeat(281) });
  assert.equal(longDescription.ok, false);
  assert.match(longDescription.error, /280 characters/);

  assert.equal(normalizeProfileInput({ display_name: "x".repeat(64) }).ok, true);
});

test("normalizeProfileInput rejects non-object bodies and non-string fields", () => {
  assert.equal(normalizeProfileInput(null).ok, false);
  assert.equal(normalizeProfileInput("nope").ok, false);
  assert.equal(normalizeProfileInput([]).ok, false);
  assert.equal(normalizeProfileInput({ display_name: 42 }).ok, false);
});

/** The shape team addresses are issued in, plus the ones that are not. Shared by
 *  the derivation tests and by the client/server drift check below. */
const NAME_CASES = [
  ["artur.medrygal@handsontable.com", "Artur Medrygal"],
  ["artur.mędrygał@handsontable.com", "Artur Mędrygał"],
  // Double-barrelled given names keep their hyphen and both capitals.
  ["anna-maria.kowalska@handsontable.com", "Anna-Maria Kowalska"],
  // Three segments: middle names are not special-cased away.
  ["anna.maria.kowalska@handsontable.com", "Anna Maria Kowalska"],
  // An ALL-CAPS address should not shout on every card.
  ["ARTUR.MEDRYGAL@handsontable.com", "Artur Medrygal"],
  // Addresses that don't follow the convention degrade to a capitalised word
  // rather than to something wrong.
  ["dev@handsontable.com", "Dev"],
  ["qa-bot@handsontable.com", "Qa-Bot"],
  // Defensive: empty segments must not become empty words.
  ["a..b@handsontable.com", "A B"],
  // No local part at all — return something rather than "".
  ["@handsontable.com", "@handsontable.com"],
];

test("displayNameFromEmail reads name.surname out of the address", () => {
  for (const [email, expected] of NAME_CASES) {
    assert.equal(displayNameFromEmail(email), expected, email);
  }
});

test("deriveDefaults uses the address-derived name and its initial", () => {
  const d = deriveDefaults({ email: "artur.medrygal@handsontable.com" });
  assert.equal(d.displayName, "Artur Medrygal");
  assert.equal(d.initial, "A");
  // There is no default picture, by decision (ADR-0007) — the monogram is the
  // no-avatar state, not a placeholder for one.
  assert.equal(d.avatarUrl, undefined);
  assert.deepEqual(Object.keys(d).sort(), ["displayName", "initial"]);
});

test("the client's copy of the derivation agrees with the worker's", () => {
  // `apps/authoring/src/displayName.ts` exists so the top bar can paint before
  // `GET /api/profile` answers. If the two ever disagree, the name visibly
  // changes under the reader when the fetch lands.
  for (const [email, expected] of NAME_CASES) {
    assert.equal(clientDisplayNameFromEmail(email), expected, email);
    assert.equal(
      clientDisplayNameFromEmail(email),
      displayNameFromEmail(email),
      `client and worker disagree on ${email}`,
    );
  }
});

test("the client's monogram matches the worker's initial", () => {
  for (const [email] of NAME_CASES) {
    assert.equal(clientInitialFromEmail(email), deriveDefaults({ email }).initial, email);
  }
});

test("avatarUrlFor is same-origin and keyed on the opaque id, never the email", () => {
  const url = avatarUrlFor("2f1c0c2e-0d1a-4f7b-9c2e-1a2b3c4d5e6f");
  assert.equal(url, "/api/profile/avatar/2f1c0c2e-0d1a-4f7b-9c2e-1a2b3c4d5e6f");
  assert.ok(!url.includes("@"));
});
