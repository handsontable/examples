// Which demos a `GET /api/demos` call returns (DEV-2506).
//
// Split out of index.ts and kept free of bindings so
// `pipeline/demos-list.test.mjs` can load it under `--experimental-strip-types` —
// the same arrangement `profile.ts` uses, and for the same reason: there is no
// worker-level test harness in this repo, so the decisions worth testing have to
// live in a module that runs in plain Node.
//
// The listing is *visibility*, not permission. Everyone signed in may look at
// everyone's demos; only the owner may change one, and that is enforced in the
// PATCH/DELETE handlers against `created_by`, not here. Keeping the two apart is
// deliberate — a scope that also granted rights would be one refactor away from
// letting `?scope=all` mean "edit anything".

/** The columns the listing returns. `created_by` is in it for `scope=all`: the UI
 *  has to know whose demo a card is to render it read-only. */
const COLUMNS = [
  "id",
  "title",
  "description",
  "framework",
  "tier",
  "ht_version",
  "forked_from",
  "visibility",
  "revoked",
  "created_at",
  "updated_at",
  "created_by",
].join(",");

export type DemoScope = "mine" | "all";

/**
 * `?scope=` -> a scope, defaulting to `mine`.
 *
 * Unknown values fall back to `mine` rather than 400: this is a listing, the
 * caller is already authenticated, and the safe reading of a typo is "show me
 * less", never "show me everything".
 */
export function parseDemoScope(raw: string | null | undefined): DemoScope {
  return raw === "all" ? "all" : "mine";
}

/**
 * The query for one scope. Returned as `{ sql, binds }` rather than run here so
 * this module needs no D1 binding.
 *
 * `scope=all` hides revoked demos; `scope=mine` shows them. A revoked demo is
 * still yours — the card renders with a `revoked` badge so you can see what
 * happened to a link you shared — but it is nothing to anyone else, and a
 * team-wide list of other people's dead links is noise.
 */
export function demoListQuery(scope: DemoScope, email: string): { sql: string; binds: string[] } {
  if (scope === "all") {
    return {
      sql: `SELECT ${COLUMNS} FROM demos WHERE revoked = 0 ORDER BY updated_at DESC`,
      binds: [],
    };
  }
  // LOWER() on both sides: addresses are normalised on the way in now, but rows written
  // before that are not, and "My demos" silently missing one is the worst way to find out.
  return {
    sql: `SELECT ${COLUMNS} FROM demos WHERE LOWER(created_by) = ? ORDER BY updated_at DESC`,
    binds: [email.trim().toLowerCase()],
  };
}
