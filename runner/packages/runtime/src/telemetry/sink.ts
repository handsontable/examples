// One write surface for an `AePoint` (`metrics.ts#toAePoint`), so the o11y worker,
// the API worker and a local dev/test run all call the same shape. Structural
// only: `AnalyticsEngineDatasetLike` mirrors the real Workers binding without
// importing `@cloudflare/workers-types` (this package stays Cloudflare-free).

import type { AePoint } from "./metrics.js";

export interface AeSink {
  /** Mirrors the real `AnalyticsEngineDataset#writeDataPoint` signature: normally
   *  fire-and-forget (`void`), but `clickhouseSink`'s HTTP write returns a promise
   *  a caller that cares about local-dev delivery may await. */
  writeDataPoint(point: AePoint): void | Promise<void>;
}

/** Structural mirror of Cloudflare's `AnalyticsEngineDataset` binding. */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: { indexes: string[]; blobs?: string[]; doubles?: number[] }): void;
}

/** Production sink: the real Analytics Engine binding (§4, `RUNNER_EVENTS`). */
export function bindingSink(dataset: AnalyticsEngineDatasetLike): AeSink {
  return {
    writeDataPoint(point: AePoint): void {
      dataset.writeDataPoint(point);
    },
  };
}

/**
 * `date` as raw epoch milliseconds — the value to send a `DateTime64(3)`
 * column over JSONEachRow (T00-D2, revised; see `clickhouseSink`'s doc
 * comment for the measured reasoning). Exported for
 * `pipeline/telemetry-sink.test.mjs`.
 */
export function clickhouseTimestamp(date: Date): number {
  return date.getTime();
}

export interface ClickhouseSinkOptions {
  /** Table name — `runner_events` (§10) by default. */
  table?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** ClickHouse HTTP user (`X-ClickHouse-User`). `"default"` if omitted, the
   *  same default T01's `compose.yml` uses. */
  user?: string;
  /** ClickHouse HTTP password (`X-ClickHouse-Key`) — T01's local container
   *  always requires one (`CLICKHOUSE_PASSWORD`, defaulting to
   *  `local-dev-token` from `AE_SQL_TOKEN`); T02 passes `env.AE_SQL_TOKEN`.
   *  Measured (T00-D2, revised): with no credentials sent at all, T01's
   *  container answers the insert with a non-2xx auth error, which a version
   *  of this sink that only checked "did `fetch` throw" swallowed —
   *  `writeDataPoint` resolved, `SELECT count()` on the table read `0`. Omit
   *  only against a ClickHouse that genuinely has no auth configured. */
  password?: string;
}

/**
 * Local-mode sink (§10): ClickHouse at `http://localhost:8123` (or wherever
 * `url` points), table `runner_events` with the §4 columns plus `timestamp` and
 * `_sample_interval` (always `1` locally — no real sampling), DDL in
 * `containers/o11y/local/clickhouse-init.sql` (T01, confirmed column-for-
 * column identical to what this sink writes: `index1`, `blob1`…`blob20` as
 * `String`, `double1`…`double20` as `Float64`, `timestamp` as
 * `DateTime64(3)`, `_sample_interval` — T00-D2).
 *
 * `timestamp` is sent as a raw epoch-millisecond integer (`clickhouseTimestamp`),
 * not a formatted string — measured against a real, throwaway
 * `clickhouse/clickhouse-server:24.10-alpine` container running T01's exact DDL
 * (the image tag T01's `compose.yml` pins), read via `toUnixTimestamp64Milli`:
 *
 * - A bare Unix-**seconds** integer (the first version of this sink) is not
 *   read as seconds at all: ClickHouse reads a plain integer into a
 *   `DateTime64(3)` column as raw **milliseconds** ticks — the column's own
 *   declared scale — so `1758628800` (meant as seconds) landed on
 *   `1970-01-21 08:30:28.800`, off by a factor of 1000. A wrong guess, not
 *   truncated precision as an earlier version of this comment claimed.
 * - A `'YYYY-MM-DD HH:MM:SS.sss'` **string** (this sink's second version)
 *   round-trips exactly correct under a UTC server timezone, but is parsed in
 *   the server's configured timezone — under a `session_timezone` override to
 *   `Asia/Tokyo` in the same measurement, the identical string parsed 9 hours
 *   off. Not safe to ship without pinning the container's timezone, which
 *   nothing here does.
 * - A raw **epoch-millisecond integer** (`Date.getTime()`, this version) is a
 *   pure tick count — `toUnixTimestamp64Milli` returned it back byte-for-byte
 *   identical, and being unit-less it cannot be timezone-dependent by
 *   construction. This is what `clickhouseTimestamp` sends.
 *
 * Column names are the AE slot names themselves — the same query a real
 * Analytics Engine SQL call would run, no second name mapping.
 *
 * **Authenticates, and rejects on a non-2xx response** — both measured
 * against the same real container: with no `user`/`password` sent, T01's
 * `compose.yml` container answers every insert with `403` (`Authentication
 * failed`), and an earlier version of this function only checked whether
 * `fetch` itself threw, so `writeDataPoint` resolved anyway — `SELECT
 * count()` on the table read back `0`. Every non-2xx response now rejects
 * the returned promise with the status and the first 200 bytes of the body,
 * and the credentials (`X-ClickHouse-User` / `X-ClickHouse-Key`, ClickHouse's
 * own HTTP header names) are sent whenever `options.user`/`.password` are
 * given — T02 passes `env.AE_SQL_TOKEN`.
 */
export function clickhouseSink(url: string, options: ClickhouseSinkOptions = {}): AeSink {
  const table = options.table ?? "runner_events";
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.user !== undefined) headers["X-ClickHouse-User"] = options.user;
  if (options.password !== undefined) headers["X-ClickHouse-Key"] = options.password;

  return {
    writeDataPoint(point: AePoint): Promise<void> {
      const row: Record<string, string | number> = {
        timestamp: clickhouseTimestamp(new Date()),
        _sample_interval: 1,
        index1: point.indexes[0] ?? "",
      };
      point.blobs.forEach((value, i) => {
        row[`blob${i + 1}`] = value;
      });
      point.doubles.forEach((value, i) => {
        row[`double${i + 1}`] = value;
      });
      const endpoint = `${url.replace(/\/$/, "")}/?query=${encodeURIComponent(
        `INSERT INTO ${table} FORMAT JSONEachRow`,
      )}`;
      return doFetch(endpoint, { method: "POST", headers, body: `${JSON.stringify(row)}\n` }).then(
        async (res: { ok: boolean; status: number; text?: () => Promise<string> }) => {
          if (!res.ok) {
            const body = (await res.text?.()) ?? "";
            throw new Error(`clickhouseSink: insert failed, ${res.status}: ${body.slice(0, 200)}`);
          }
        },
      );
    },
  };
}

export interface MemorySink extends AeSink {
  /** Every point written so far, in write order. Tests read this directly. */
  readonly points: AePoint[];
}

/** Test sink: collects every point, writes nothing anywhere. */
export function memorySink(): MemorySink {
  const points: AePoint[] = [];
  return {
    points,
    writeDataPoint(point: AePoint): void {
      points.push(point);
    },
  };
}
