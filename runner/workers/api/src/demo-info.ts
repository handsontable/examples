// Validation for a demo's title and description (DEV-2507).
//
// Binding-free so `pipeline/demo-info.test.mjs` can drive it, the arrangement
// `profile.ts` established.
//
// The description is markdown *text*. Nothing here parses or sanitises it: it is
// rendered by `markdownParser.ts` + `markdown.tsx`, which emit typed nodes and
// build React elements from them — there is no raw-HTML path to inject into, and
// `safeHref` already refuses anything that is not http/https. Escaping it here
// would corrupt the source without adding any safety.

/** Descriptions ride along in the bulk listing (`GET /api/demos`), so an
 *  unbounded field makes that response unbounded too. */
export const MAX_DESCRIPTION = 4000;

/** Titles are one line in a 334px card. */
export const MAX_TITLE = 200;

export type ValidationError = { error: string };

/** A trimmed, non-empty title, or the 400 message for it. */
export function validateTitle(raw: unknown): string | ValidationError {
  if (typeof raw !== "string" || !raw.trim()) return { error: "title is required" };
  const title = raw.trim();
  if (title.length > MAX_TITLE) return { error: `title must be ${MAX_TITLE} characters or fewer` };
  return title;
}

/**
 * The description as it should be stored, or the 400 message.
 *
 * Three states have to survive, and only the first two are the same thing:
 *  - `undefined` — the caller did not mention it. PATCH leaves the column alone.
 *  - `null` / `""` — cleared. Stored as `null` so "no description" is one value in
 *    the column rather than two.
 *  - text — kept **verbatim**, newlines and all. Trimming the ends is safe;
 *    collapsing anything inside would eat the blank line between two paragraphs,
 *    which is the whole point of markdown descriptions.
 */
export function validateDescription(raw: unknown): string | null | undefined | ValidationError {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return { error: "description must be a string" };
  if (raw.length > MAX_DESCRIPTION) {
    return { error: `description must be ${MAX_DESCRIPTION} characters or fewer` };
  }
  const description = raw.replace(/\r\n/g, "\n").replace(/^\s+|\s+$/g, "");
  return description ? description : null;
}

/** Narrowing helper, so callers read as `if (isError(x)) return json(x, 400)`. */
export function isValidationError(value: unknown): value is ValidationError {
  return typeof value === "object" && value !== null && "error" in value;
}
