// The owner filter on `/all-demos` (DEV-2519).
//
// Pure, so `pipeline/demo-owners.test.mjs` can cover the counting, the ordering
// and the matching without a browser — the parts that are easy to get subtly
// wrong and invisible when they are.
//
// The name formatter arrives as an argument rather than an import. Two reasons, and
// the second is the binding one: grouping rows is not the same concern as
// formatting a person's name, and a module the pipeline tests load cannot import a
// sibling `./x.js` under `--experimental-strip-types` (the constraint that also
// keeps `profile.ts` and `demos-list.ts` dependency-free).
//
// Options come from the demos in hand rather than from a user directory: the point
// of the filter is "whose demos are in this list", and a name with no demos behind
// it is a dead entry.

/** A row's owner, as the filter identifies them. */
export interface OwnerOption {
  /** `?owner=` value. Empty string means everyone. */
  value: string;
  /** What the dropdown shows, count included. */
  label: string;
  count: number;
}

interface OwnedRow {
  created_by: string;
}

/**
 * The address's local part, lowercased — `marek.martuszewski`.
 *
 * The URL value on purpose, rather than the whole address: a filtered link gets
 * pasted into Slack, and the domain adds nothing (everyone here is
 * `@handsontable.com`) while the full email travels further than it needs to.
 */
export function ownerSlug(email: string): string {
  return email.trim().toLowerCase().split("@")[0] ?? "";
}

/**
 * One option per owner present, `Everyone` first.
 *
 * Sorted by the displayed name rather than by the address, because that is the
 * order the reader sees — sorting by email puts `zoe.b` before `adam.zawadzki`
 * whenever the local parts disagree with the names.
 */
export function ownerOptions(
  demos: OwnedRow[],
  formatName: (email: string) => string,
): OwnerOption[] {
  const counts = new Map<string, number>();
  for (const demo of demos) {
    const slug = ownerSlug(demo.created_by ?? "");
    if (!slug) continue;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }

  const owners = [...counts.entries()]
    .map(([slug, count]) => ({
      value: slug,
      count,
      name: formatName(`${slug}@handsontable.com`),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ value, count, name }) => ({ value, count, label: `${name} (${count})` }));

  return [{ value: "", label: `Everyone (${demos.length})`, count: demos.length }, ...owners];
}

/** The rows one option shows. An empty or unknown slug is not an error: the URL is
 *  user-editable, and an unrecognized owner honestly has no demos. */
export function filterByOwner<T extends OwnedRow>(demos: T[], slug: string): T[] {
  const wanted = slug.trim().toLowerCase();
  if (!wanted) return demos;
  return demos.filter((demo) => ownerSlug(demo.created_by ?? "") === wanted);
}

/** The name for a slug, for the "no demos from …" line. Named for its input: the
 *  page already has an `ownerName` (the signed-in user's, for the card byline) and
 *  two things called the same would shadow each other. */
export function ownerNameFromSlug(slug: string, formatName: (email: string) => string): string {
  return formatName(`${slug}@handsontable.com`);
}
