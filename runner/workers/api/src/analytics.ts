// Anonymous audience analytics for the demo runner (DEV-2030 follow-up).
//
// A deliberately small, privacy-preserving subset of what an analytics product
// gives you: how many views and unique visitors, which demos and pages, where
// people came from, roughly what they were using. Enough to decide what to
// build and what the runner costs; not enough to follow anyone around.
//
// The rules that make that true, and that any change here must keep:
//
//   * No cookies, no localStorage, no client-side id of any kind.
//   * No IP addresses, no user-agent strings, no full URLs, no query strings
//     are ever written down. Everything is bucketed into a small fixed set of
//     labels at the moment of the request.
//   * Unique visitors are counted from a one-way hash of
//     (daily random salt + IP + user agent). The salt lives in KV for ~48h and
//     then it is gone, so the hashes cannot be reversed with a known IP after
//     the fact and cannot be joined across days. Same approach as Plausible.
//   * Counters are aggregated per day at write time; there is no event table
//     and therefore no per-request history to leak or subpoena.
//   * Obvious bots are counted once, in their own bucket, and excluded from
//     everything else so the numbers mean something.

import type { Env } from "./env.js";

const SALT_TTL_SECONDS = 60 * 60 * 48;
const FLUSH_AT_EVENTS = 100;
/** Labels are truncated, not just to keep the table small but because a long
 *  label is a sign of something that should not have become a label. */
const MAX_LABEL_LENGTH = 48;
/** Referrer hostnames come from a header anyone can set, so a crawler could
 *  invent a new one per request. Yesterday's one-hit referrers are folded into
 *  'other' by the nightly prune, which bounds the table without costing
 *  anything on the hot path. */
const RARE_REFERRER_VIEWS = 3;

export type Dimension =
  | "views" | "page" | "demo" | "referrer" | "country" | "device" | "browser" | "os" | "language" | "bot";

const utcDay = (): string => new Date().toISOString().slice(0, 10);

// ---- Bucketing ---------------------------------------------------------------

const BOT_RE = /bot|crawler|spider|crawling|slurp|bingpreview|headlesschrome|lighthouse|curl\/|wget\/|python-requests|node-fetch|axios\/|monitoring|uptime|pingdom|semrush|ahrefs|facebookexternalhit|whatsapp|telegrambot|preview/i;

export const isBot = (userAgent: string): boolean => BOT_RE.test(userAgent);

/** Coarse device class. Deliberately three buckets — anything finer starts to
 *  look like a fingerprint. */
function deviceOf(ua: string): string {
  if (/ipad|tablet|playbook|silk/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android.*mobile|windows phone/i.test(ua)) return "mobile";
  return "desktop";
}

function browserOf(ua: string): string {
  if (/edg\//i.test(ua)) return "edge";
  if (/opr\/|opera/i.test(ua)) return "opera";
  if (/chrome|crios|chromium/i.test(ua)) return "chrome";
  if (/firefox|fxios/i.test(ua)) return "firefox";
  if (/safari/i.test(ua)) return "safari";
  return "other";
}

function osOf(ua: string): string {
  if (/windows/i.test(ua)) return "windows";
  if (/iphone|ipad|ipod|ios/i.test(ua)) return "ios";
  if (/mac os x|macintosh/i.test(ua)) return "macos";
  if (/android/i.test(ua)) return "android";
  if (/linux|x11|cros/i.test(ua)) return "linux";
  return "other";
}

/** Referring *hostname* only. A full referrer URL can carry a search query or
 *  a private path, so the path and query never leave this function. */
function referrerOf(referer: string | null, selfHost: string): string {
  if (!referer) return "direct";
  try {
    const host = new URL(referer).hostname.replace(/^www\./, "");
    if (!host) return "direct";
    return host === selfHost.replace(/^www\./, "") ? "internal" : host.slice(0, MAX_LABEL_LENGTH);
  } catch {
    return "unknown";
  }
}

/** Primary language subtag ("en-GB,en;q=0.9" -> "en"). */
function languageOf(header: string | null): string {
  const tag = header?.split(",")[0]?.trim().split("-")[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(tag) ? tag : "unknown";
}

/**
 * Normalise a path into one of a small set of page labels.
 *
 * Ids are kept for demo routes (they are ours, they are what the panel is
 * about) and stripped everywhere else. Query strings are always dropped —
 * `?docs=` and `?example=` are reported separately, as a bounded label.
 */
export function normalisePage(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  const demo = /^\/(d|embed)\/([A-Za-z0-9_-]{1,32})/.exec(path);
  if (demo) return `/${demo[1]}/${demo[2]}`;
  if (/^\/edit\//.test(path)) return "/edit/:id";
  if (/^\/share\//.test(path)) return "/share/:id";
  if (path === "/" || path === "/admin") return path;
  return "/other";
}

// ---- Visitor hashing ---------------------------------------------------------

let saltCache: { day: string; salt: string } | null = null;

/**
 * The day's random salt, created on first use and dropped by KV after ~48h.
 *
 * Rotation is the whole point: once the salt is gone, nobody — including us —
 * can take an IP and work out whether it appears in yesterday's counts.
 */
async function dailySalt(env: Env): Promise<string> {
  const day = utcDay();
  if (saltCache?.day === day) return saltCache.salt;

  const key = `analytics:salt:${day}`;
  let salt = await env.CACHE.get(key).catch(() => null);
  if (!salt) {
    salt = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // Racing isolates may each generate one; last writer wins and the loser's
    // visitors simply hash differently for a moment. Not worth a lock.
    await env.CACHE.put(key, salt, { expirationTtl: SALT_TTL_SECONDS }).catch(() => {});
  }
  saltCache = { day, salt };
  return salt;
}

async function visitorHash(env: Env, ip: string, ua: string): Promise<string> {
  const salt = await dailySalt(env);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}|${ua}`));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Accumulator -------------------------------------------------------------
//
// Same batching as the cost meters: counting a page view must not cost a D1
// write. Isolate eviction drops a partial batch, which for audience counts is
// an acceptable rounding error.

const pendingCounts = new Map<string, number>();
const pendingVisitors = new Set<string>();
let pendingEvents = 0;

/**
 * Record one page view. Returns true when a flush is worth a D1 batch.
 *
 * Everything it needs comes off the request; nothing identifying survives the
 * call — `ip` and `ua` are consumed by the hash and never stored.
 */
export async function notePageView(
  env: Env,
  request: Request,
  opts: { page: string; demoId?: string },
): Promise<boolean> {
  const ua = request.headers.get("user-agent") ?? "";
  const bump = (dimension: Dimension, value: string) => {
    const key = `${dimension}|${value.slice(0, MAX_LABEL_LENGTH)}`;
    pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + 1);
  };

  pendingEvents++;
  if (isBot(ua)) {
    // Counted, so the gap between "views" and reality is visible, but kept out
    // of every other bucket.
    bump("bot", "bot");
    return pendingEvents >= FLUSH_AT_EVENTS;
  }

  const url = new URL(request.url);
  const cf = (request as Request & { cf?: { country?: string } }).cf;

  bump("views", "");
  bump("page", opts.page);
  if (opts.demoId) bump("demo", opts.demoId);
  bump("referrer", referrerOf(request.headers.get("referer"), url.hostname));
  bump("country", (cf?.country ?? "unknown").toLowerCase());
  bump("device", deviceOf(ua));
  bump("browser", browserOf(ua));
  bump("os", osOf(ua));
  bump("language", languageOf(request.headers.get("accept-language")));

  const ip = request.headers.get("cf-connecting-ip") ?? "";
  if (ip) {
    try {
      pendingVisitors.add(await visitorHash(env, ip, ua));
    } catch { /* a missing unique is better than a failed page load */ }
  }

  return pendingEvents >= FLUSH_AT_EVENTS;
}

/** Write and reset the accumulator. Safe to call when empty. */
export async function flushAnalytics(env: Env): Promise<void> {
  if (pendingCounts.size === 0 && pendingVisitors.size === 0) return;
  const counts = [...pendingCounts.entries()];
  const visitors = [...pendingVisitors];
  pendingCounts.clear();
  pendingVisitors.clear();
  pendingEvents = 0;

  const day = utcDay();
  const now = Date.now();
  const statements = counts.map(([key, views]) => {
    const sep = key.indexOf("|");
    return env.DB.prepare(
      `INSERT INTO analytics_daily (day, dimension, value, views, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(day, dimension, value) DO UPDATE
            SET views = views + ?4, updated_at = ?5`,
    ).bind(day, key.slice(0, sep), key.slice(sep + 1), views, now);
  });
  for (const visitor of visitors) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO analytics_visitors (day, visitor) VALUES (?1, ?2)").bind(day, visitor),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch {
    // Put it back rather than losing the batch; the next flush retries.
    for (const [key, views] of counts) pendingCounts.set(key, (pendingCounts.get(key) ?? 0) + views);
    for (const visitor of visitors) pendingVisitors.add(visitor);
    pendingEvents += counts.length;
  }
}

// ---- Reporting ---------------------------------------------------------------

export interface AnalyticsReport {
  totals: { views: number; visitors: number; bots: number };
  daily: { day: string; views: number; visitors: number }[];
  pages: { value: string; views: number }[];
  demos: { value: string; views: number }[];
  referrers: { value: string; views: number }[];
  countries: { value: string; views: number }[];
  devices: { value: string; views: number }[];
  browsers: { value: string; views: number }[];
  languages: { value: string; views: number }[];
}

const topOf = (rows: { dimension: string; value: string; views: number }[], dimension: Dimension, limit = 10) =>
  rows
    .filter((r) => r.dimension === dimension)
    .sort((a, b) => b.views - a.views)
    .slice(0, limit)
    .map(({ value, views }) => ({ value, views }));

/** Everything the panel's audience section renders, in one pass over the day
 *  buckets in the window. */
export async function analyticsReport(env: Env, days: number): Promise<AnalyticsReport> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const [buckets, perDay, visitorsPerDay] = await Promise.all([
    env.DB.prepare(
      `SELECT dimension, value, SUM(views) AS views
         FROM analytics_daily WHERE day >= ?1 GROUP BY dimension, value`,
    ).bind(since).all<{ dimension: string; value: string; views: number }>(),

    env.DB.prepare(
      `SELECT day, SUM(views) AS views FROM analytics_daily
        WHERE day >= ?1 AND dimension = 'views' GROUP BY day ORDER BY day DESC`,
    ).bind(since).all<{ day: string; views: number }>(),

    env.DB.prepare(
      `SELECT day, COUNT(*) AS visitors FROM analytics_visitors
        WHERE day >= ?1 GROUP BY day ORDER BY day DESC`,
    ).bind(since).all<{ day: string; visitors: number }>(),
  ]);

  const rows = buckets.results ?? [];
  const visitorsByDay = new Map((visitorsPerDay.results ?? []).map((r) => [r.day, r.visitors]));
  const sumOf = (dimension: Dimension) =>
    rows.reduce((n, r) => (r.dimension === dimension ? n + r.views : n), 0);

  return {
    totals: {
      views: sumOf("views"),
      // Unique *per day*; summing days deliberately double-counts a returning
      // visitor, because the salt rotation means we genuinely cannot tell.
      visitors: [...visitorsByDay.values()].reduce((n, v) => n + v, 0),
      bots: sumOf("bot"),
    },
    daily: (perDay.results ?? []).map((r) => ({
      day: r.day,
      views: r.views,
      visitors: visitorsByDay.get(r.day) ?? 0,
    })),
    pages: topOf(rows, "page"),
    demos: topOf(rows, "demo"),
    referrers: topOf(rows, "referrer"),
    countries: topOf(rows, "country"),
    devices: topOf(rows, "device", 5),
    browsers: topOf(rows, "browser", 6),
    languages: topOf(rows, "language", 8),
  };
}

/** Housekeeping for the nightly cron: audience data past the retention window
 *  is deleted outright. Aggregates are cheap to keep, visitor hashes are not
 *  worth keeping at all once the salt that made them is gone. */
export async function pruneAnalytics(env: Env, retentionDays: number): Promise<void> {
  const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  const yesterday = day(1);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM analytics_visitors WHERE day < ?1").bind(day(retentionDays)),
    env.DB.prepare("DELETE FROM analytics_daily WHERE day < ?1").bind(day(Math.max(retentionDays, 400))),

    // Fold rare referrers of completed days into 'other'. Keeps the long tail
    // of one-hit (and possibly invented) hostnames from accumulating, while
    // leaving the totals correct.
    env.DB.prepare(
      `INSERT INTO analytics_daily (day, dimension, value, views, updated_at)
       SELECT day, 'referrer', 'other', SUM(views), ?2 FROM analytics_daily
        WHERE dimension = 'referrer' AND value != 'other' AND day <= ?1 AND views < ?3
        GROUP BY day
       ON CONFLICT(day, dimension, value) DO UPDATE SET views = views + excluded.views, updated_at = ?2`,
    ).bind(yesterday, Date.now(), RARE_REFERRER_VIEWS),
    env.DB.prepare(
      `DELETE FROM analytics_daily
        WHERE dimension = 'referrer' AND value != 'other' AND day <= ?1 AND views < ?2`,
    ).bind(yesterday, RARE_REFERRER_VIEWS),
  ]);
}
