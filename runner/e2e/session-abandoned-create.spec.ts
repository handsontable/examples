import { createHash } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";

// DEV-2567. `/admin` filled with phantom Angular rows: 202 of them, spread evenly
// from minutes to 24h old, against an instance pool capped at 5.
//
// The cause is an ordering, not a leak of containers. The client mints the session
// id and registers its `pagehide` teardown BEFORE the create POST, deliberately, so
// a tab closed mid-create can still DELETE. When that happens the small keepalive
// DELETE can reach the Worker before the large POST body has finished uploading:
//
//   1. DELETE runs first. It tombstones, then calls `meterSession(final)` — which
//      finds no meter key yet and returns early — and destroys nothing.
//   2. The create handler then runs and `startSessionMeter()` WRITES the meter.
//   3. `closedWhileCreating()` sees the tombstone, destroys the container and
//      answers 410 — but used to leave that meter behind.
//
// So the container was reclaimed correctly and only the meter leaked, for its full
// 24h TTL, one row per abandoned create. Angular dominates for two independent
// reasons: it has the largest starter payload and the slowest boot, so its create
// window is by far the widest; and it is the only container-engine flavour the
// documentation embeds, so every container session a docs visitor starts is Angular.
//
// Deterministic and browser-free — it drives the API in the ordering the race
// produces rather than trying to win a real one, which is why it does not need
// `E2E_LIVE=1`. It does need the API worker, so it is skipped without one: a green
// run against nothing would be worse than no test.

const apiBase = process.env.E2E_API_BASE ?? "http://localhost:8787";

/** A minimal Angular payload. The starter's real contents are irrelevant — this
 *  test is about the create/teardown ordering, and a create that fails to install
 *  still books a meter, which is precisely the thing under test. */
const angularPayload = (sessionId: string) => ({
  framework: "angular",
  sessionId,
  files: {
    "package.json": JSON.stringify({ name: "abandoned", private: true, type: "module" }),
    "src/main.ts": "console.log('abandoned create');\n",
  },
});

/** Session ids must be unique per create — the tombstone TTL outlives them. */
const mintId = (tag: string) =>
  `angular-${tag}${Math.random().toString(16).slice(2, 8)}`;

/** The digest the panel shows for a session id — `sessionRef` in
 *  workers/api/src/session-listing.ts. Recomputed here rather than counting rows:
 *  these tests run in parallel against one KV, and anything asserting on totals
 *  would be measuring the other tests' sessions too. */
const refFor = (sessionId: string): string =>
  createHash("sha256").update(sessionId).digest("hex").slice(0, 8);

/** Every ref the panel is metering, across ALL pages.
 *
 *  Paged deliberately rather than read as one `limit=200` page. Rows sort
 *  oldest-first and `SESSIONS_MAX_PAGE_SIZE` is 200, so on an instance carrying a
 *  real backlog — the incident that opened DEV-2567 had 202 rows — a
 *  just-created meter is the LAST row and falls off the first page entirely.
 *  A `.not.toContain()` assertion against that page passes whether or not the
 *  meter leaked, which would make the two cases below permanently, invisibly
 *  green. That is the one failure mode a regression test must not have.
 */
async function meteredRefs(request: APIRequestContext): Promise<string[]> {
  const headers = process.env.E2E_BROKER_TOKEN
    ? { Authorization: `Bearer ${process.env.E2E_BROKER_TOKEN}` }
    : undefined;
  const limit = 200; // SESSIONS_MAX_PAGE_SIZE; a larger ask is clamped to it
  const refs: string[] = [];
  let offset = 0;
  // Bounded so a miscounted `total` cannot spin forever; 40 pages is 8000 rows,
  // far past anything 24h of Tier-2 traffic can produce.
  for (let page = 0; page < 40; page += 1) {
    const res = await request.get(
      `${apiBase}/api/admin/sessions?awake=0&limit=${limit}&offset=${offset}`,
      { headers },
    );
    expect(res.ok(), `admin sessions read failed (${res.status()})`).toBeTruthy();
    const body = (await res.json()) as {
      rows: { ref: string }[];
      total: number;
      truncated: boolean;
    };
    // The server could not enumerate the whole prefix, so neither can we, and an
    // absent ref would prove nothing. Fail rather than conclude.
    expect(body.truncated, "the KV scan was truncated — this run cannot conclude").toBe(false);
    refs.push(...body.rows.map((r) => r.ref));
    if (refs.length >= body.total || body.rows.length === 0) return refs;
    offset += limit;
  }
  throw new Error("admin sessions did not finish paging within the page budget");
}

test.describe("an abandoned create leaves nothing metered behind", () => {
  test.beforeEach(async ({ request }) => {
    const health = await request.get(`${apiBase}/api/health`).catch(() => null);
    test.skip(!health?.ok(), `no API worker at ${apiBase} — start one or set E2E_API_BASE`);
  });

  test("a DELETE that overtakes the create does not strand a meter", async ({ request }) => {
    const sessionId = mintId("race");

    // The tab is already gone before the create is processed.
    const deleted = await request.delete(`${apiBase}/api/session/${sessionId}`);
    expect(deleted.status(), "teardown of a not-yet-created session is a satisfied no-op").toBe(204);

    const created = await request.post(`${apiBase}/api/session`, { data: angularPayload(sessionId) });
    // The create ran, found the tombstone at the end, and tore down what it built.
    expect(created.status(), "a create that lost the race must refuse, not succeed").toBe(410);

    expect(
      await meteredRefs(request),
      "the abandoned create left a phantom row on /admin",
    ).not.toContain(refFor(sessionId));
  });

  test("repeated abandoned creates do not accumulate", async ({ request }) => {
    // One leak is a bug; the reported symptom was 202 of them. A single-shot
    // assertion would pass against a fix that only handles the first.
    const abandoned: string[] = [];
    for (const tag of ["a", "b", "c", "d"]) {
      const sessionId = mintId(tag);
      abandoned.push(sessionId);
      await request.delete(`${apiBase}/api/session/${sessionId}`);
      const created = await request.post(`${apiBase}/api/session`, { data: angularPayload(sessionId) });
      expect(created.status()).toBe(410);
    }
    const metered = await meteredRefs(request);
    for (const sessionId of abandoned) {
      expect(metered, `${sessionId} survived as a phantom row`).not.toContain(refFor(sessionId));
    }
  });

  test("a create nobody abandoned is still metered, and its teardown still clears it", async ({ request }) => {
    // The guard against fixing the leak by simply not metering creates. The meter
    // is what the budget subroute gate reads (`hasSessionMeter`), so losing it
    // would start refusing real sessions at `anon_blocked`.
    const sessionId = mintId("clean");
    const ref = refFor(sessionId);

    const created = await request.post(`${apiBase}/api/session`, { data: angularPayload(sessionId) });
    expect(created.status(), "an unraced create must succeed").toBe(200);
    expect(
      await meteredRefs(request),
      "a live session must appear on the panel",
    ).toContain(ref);

    const deleted = await request.delete(`${apiBase}/api/session/${sessionId}`);
    expect(deleted.status()).toBe(204);
    expect(await meteredRefs(request), "a clean teardown must clear the row").not.toContain(ref);
  });
});
