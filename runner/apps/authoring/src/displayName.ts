// A display name from a `@handsontable.com` address (ADR-0007).
//
// This is a deliberate second copy of `workers/api/src/profile.ts`'s
// `displayNameFromEmail`. The worker is authoritative — every `GET /api/profile`
// returns a resolved `display_name` — but the client needs the same answer
// *before* that call lands, or the top bar and the My Demos author line paint
// the raw local part and visibly flip a moment later.
//
// The app cannot import the worker's module: `workers/api` is not a dependency
// of this app, and making it one would pull the Worker's typings into a browser
// build. Instead `pipeline/profile.test.mjs` imports both files and asserts they
// agree on a table of addresses, so the copies cannot drift silently.

const capitalize = (word: string): string =>
  word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word;

export function displayNameFromEmail(email: string): string {
  const localPart = (email.split("@")[0] ?? "").trim();
  if (!localPart) return email.trim();
  const words = localPart
    .split(".")
    .filter(Boolean)
    .map((token) => token.split("-").map(capitalize).join("-"));
  return words.length ? words.join(" ") : localPart;
}

/** The monogram drawn wherever there is no uploaded avatar — there is no default
 *  picture, so this is the no-avatar state rather than a placeholder for one. */
export function initialFromEmail(email: string): string {
  const name = displayNameFromEmail(email);
  return (name.trim()[0] ?? email.trim()[0] ?? "?").toUpperCase();
}
