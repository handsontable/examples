// What the admin panel's "Live sessions" table is allowed to claim, and how a
// row gets turned back into something an operator can act on (DEV-2567).
//
// The bug this file answers: the table listed one row per `session-meter:` key
// in KV and called it live. Those keys carry `KV_METER_TTL_SECONDS` = 24h, while
// the container behind one sleeps after `sleepAfter` = 5m — so every session
// whose client vanished without a clean `DELETE /api/session/:id` (a killed tab,
// a dropped `keepalive` fetch, a bfcache eviction that never fires a second
// `pagehide`) stayed on the panel for up to a day with its Awake and Est. cost
// columns climbing. The reported symptom was 50 rows against a 5-instance pool.
// Nothing was leaking: `containers.max_instances` is a real cap and the ledger
// is fed by keepalive flushes, not by this table. The table was the defect.
//
// Two things follow, and both live here rather than in `admin.ts` so they can be
// tested without a KV binding:
//  - a meter has a *state* (`awake` / `slept`), inferred from its own last tick;
//  - a `ref` is resolvable back to a session id, which is what lets an operator
//    tear one down from the panel without the panel ever holding an id.
//
// Deliberately free of Cloudflare imports and of runtime sibling imports, and
// written in erasable syntax only (no enum, no parameter properties), so
// `pipeline/` can import this `.ts` directly under `--experimental-strip-types`
// — the same constraint `session-lifecycle.ts` and `preview-boot.ts` document.

/**
 * How long after a meter's last tick we stop calling the session awake.
 *
 * Tied to `sleepAfter = "5m"` in `index.ts`, and shared with `budget.ts` as
 * `MAX_UNSEEN_AWAKE_SECONDS` — the billing cap on an unobserved gap is the same
 * number for the same reason: past this point the container has scaled to zero
 * and stopped billing, so neither charging for the gap nor calling it live is
 * defensible.
 *
 * The margin against a false "slept" is comfortable but not infinite. The meter
 * ticks only on `GET /api/session/:id/status`, which the client calls every 60s
 * (`startKeepalive`) and which books a slice only once `METER_FLUSH_SECONDS` has
 * elapsed — so a tick can be skipped and the freshest possible `meteredThrough`
 * on a healthy session is ~120s old. 300s leaves room for one more missed ping.
 *
 * KNOWN FALSE NEGATIVE, and the reason the panel's filter is a checkbox rather
 * than a hard exclusion: the keepalive is suppressed while `document
 * .visibilityState === "hidden"`, but an open HMR WebSocket still resets the
 * container's idle timer. A backgrounded tab mid-edit is therefore awake and
 * billing while its meter goes quiet, and it reads as `slept` here. Unchecking
 * the filter is what makes that session visible — and killable — again.
 */
export const AWAKE_WINDOW_SECONDS = 300;

/** Rows per page. The panel pages rather than truncating: the old `limit: 50`
 *  silently capped the table at the alphabetically-first framework, because KV
 *  lists keys in UTF-8 order and session ids start with the framework slug
 *  (`angular` sorts before `astro`, `next.js`, `nuxt`, `remix`). That is why the
 *  DEV-2567 screenshot is 50 angular rows and nothing else — the cap, not the
 *  traffic mix. Anything that bounds this table must report what it dropped. */
export const SESSIONS_PAGE_SIZE = 25;

/** Upper bound on one page, so a hand-written `?limit=` cannot ask for the world. */
export const SESSIONS_MAX_PAGE_SIZE = 200;

export type SessionState = "awake" | "slept";

/**
 * Whether a KV scan of the meter prefix saw everything there was to see.
 *
 * Lives here, apart from the scan itself in `admin.ts`, for one reason: this is
 * the decision the bug was made of. A table that quietly stops at 50 rows reads
 * exactly like a table with 50 rows in it, and that is how DEV-2567 spent months
 * looking like an Angular-specific container leak. So the bound is a value the
 * panel renders, and it is computed somewhere `pipeline/` can reach — `admin.ts`
 * imports `budget.js` and cannot be loaded under `--experimental-strip-types`.
 *
 * Two independent ways to come up short, and either one has to show:
 *  - the prefix outran the page budget (`listComplete` false on the last call);
 *  - more pre-metadata keys were found than the per-row `get` budget allows.
 */
export function scanTruncated(scan: {
  listComplete: boolean;
  legacyFound: number;
  legacyRead: number;
}): boolean {
  return !scan.listComplete || scan.legacyRead < scan.legacyFound;
}

/** The persisted meter, as `budget.ts` writes it. */
export interface MeterFacts {
  startedAt: number;
  /** Through when the awake window has been booked to the ledger. Also the
   *  liveness clock: it only advances on a keepalive tick. */
  meteredThrough: number;
}

export interface MeterState {
  /** Wall-clock age of the session, which is what the Awake column showed
   *  before and what it still shows for an awake row. */
  ageSeconds: number;
  /** Awake time we can actually stand behind: booked up to `meteredThrough`,
   *  plus at most one idle window for the tail past it.
   *
   *  Closes the day-scale gap this panel used to report — a 24h phantom prices
   *  at one flush plus one window instead of 24h — but it is NOT equal to what
   *  the ledger books, and must not be described as if it were. `meterSession`
   *  caps each individual slice at `MAX_UNSEEN_AWAKE_SECONDS` and then advances
   *  `meteredThrough` to `now` regardless, so a tab that was hidden for an hour
   *  (keepalive suppressed) and then resumed books 300s to `cost_ledger` while
   *  this figure re-absorbs the whole 3600s. Repeated gaps compound. The meter
   *  does not retain the per-slice history that would let this be exact, so
   *  treat it as an upper bound on the honest number, not as the ledger's. */
  billableSeconds: number;
  /** Since the last keepalive tick. The state below is a threshold on this. */
  quietSeconds: number;
  state: SessionState;
}

/**
 * Classify one meter.
 *
 * `now` is a parameter rather than a `Date.now()` call so the tests can pin a
 * clock. Negative intervals are clamped: KV is eventually consistent across
 * colos and a meter written by another colo can carry a timestamp slightly in
 * our future, which must read as "brand new", never as a negative duration.
 */
export function classifyMeter(meter: MeterFacts, now: number): MeterState {
  const ageSeconds = Math.max(0, (now - meter.startedAt) / 1000);
  const quietSeconds = Math.max(0, (now - meter.meteredThrough) / 1000);
  const booked = Math.max(0, (meter.meteredThrough - meter.startedAt) / 1000);
  return {
    ageSeconds,
    // The tail past `meteredThrough` is real awake time up to the idle window;
    // beyond it the container was asleep and free.
    billableSeconds: booked + Math.min(quietSeconds, AWAKE_WINDOW_SECONDS),
    quietSeconds,
    state: quietSeconds <= AWAKE_WINDOW_SECONDS ? "awake" : "slept",
  };
}

// ---- the request the panel makes -------------------------------------------

export interface SessionQuery {
  /** Default TRUE. The panel opens on "sessions that are actually running";
   *  the 24h tail is one unchecked box away, because that tail is exactly where
   *  a phantom row has to be visible to be killed. */
  awakeOnly: boolean;
  offset: number;
  limit: number;
}

/** Anything with URLSearchParams' read shape, so tests need no URL. */
export interface ParamReader {
  get(name: string): string | null;
}

const clampInt = (raw: string | null, fallback: number, min: number, max: number): number => {
  // An absent parameter has to short-circuit before `Number`, which reads both
  // `null` and `""` as a perfectly finite 0 — that clamps to `min`, so a caller
  // that simply omitted `limit` would have been answered one row per page.
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/**
 * Read the table's query string.
 *
 * `awake` is opt-OUT (`?awake=0`) rather than opt-in, so the safe, cheap view is
 * what a caller that passes nothing gets — including the `adminUsage` report,
 * whose embedded first page must not regress into the 24h dump this fixes.
 */
export function parseSessionQuery(params: ParamReader): SessionQuery {
  const awake = params.get("awake");
  return {
    awakeOnly: awake !== "0" && awake !== "false",
    offset: clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
    limit: clampInt(params.get("limit"), SESSIONS_PAGE_SIZE, 1, SESSIONS_MAX_PAGE_SIZE),
  };
}

export interface Page<T> {
  rows: T[];
  offset: number;
  limit: number;
  /** Rows matching the filter, across every page. */
  total: number;
}

/**
 * Slice a page, correcting an offset that ran off the end.
 *
 * An offset past `total` returns the LAST page rather than an empty one: the
 * panel's "next" button and a kill that shrinks the list can otherwise strand an
 * operator on a blank table with no way back except reloading.
 */
export function pageOf<T>(rows: T[], query: { offset: number; limit: number }): Page<T> {
  const limit = Math.max(1, query.limit);
  const lastPageStart = Math.max(0, Math.floor(Math.max(0, rows.length - 1) / limit) * limit);
  const offset = query.offset >= rows.length ? lastPageStart : Math.max(0, query.offset);
  return { rows: rows.slice(offset, offset + limit), offset, limit, total: rows.length };
}

// ---- refs -------------------------------------------------------------------

/** Session ids are `<framework-slug>-<8 random chars>` (see `mintSessionId`). */
export function frameworkOf(sessionId: string): string {
  const cut = sessionId.lastIndexOf("-");
  return cut > 0 ? sessionId.slice(0, cut) : sessionId;
}

/**
 * The panel's stand-in for a session id.
 *
 * Ids are bearer capabilities: `/api/session/:id/*` is unauthenticated by
 * design, so anyone holding one can write files into that container or tear it
 * down. Handing them to every signed-in viewer of the panel would let one
 * colleague interfere with another's live session, which is why the table has
 * always rendered this digest instead — and why the kill button resolves a ref
 * server-side (`resolveSessionRef`) rather than being handed an id to send back.
 *
 * Truncated to 4 bytes, which is a display decision this file inherits rather
 * than one it makes. 32 bits is ample to tell a few hundred rows apart, and the
 * one place a collision would matter — a kill — refuses instead of guessing.
 */
export async function sessionRef(sessionId: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  return [...new Uint8Array(hash)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type RefResolution =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "unknown" | "ambiguous" };

/**
 * Which session id a ref came from.
 *
 * Refuses on more than one match rather than taking the first. A 4-byte digest
 * makes that astronomically unlikely, but the action on the other side is a
 * teardown of somebody's running work — the one place where "probably right" is
 * not a good enough answer, and where the cost of being wrong is paid by a
 * person who did nothing. `ambiguous` is a distinct reason so the operator is
 * told to retry rather than told the session is gone.
 */
export async function resolveSessionRef(sessionIds: string[], ref: string): Promise<RefResolution> {
  const wanted = ref.trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(wanted)) return { ok: false, reason: "unknown" };
  const matches: string[] = [];
  for (const sessionId of sessionIds) {
    if (await sessionRef(sessionId) === wanted) matches.push(sessionId);
  }
  if (matches.length === 1) return { ok: true, sessionId: matches[0]! };
  return { ok: false, reason: matches.length === 0 ? "unknown" : "ambiguous" };
}
