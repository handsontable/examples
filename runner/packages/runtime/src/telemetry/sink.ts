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
 * column over JSONEachRow (see `clickhouseSink`'s doc comment for the
 * measured reasoning). Exported for
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
   *  same default `containers/o11y/compose.yml` uses. */
  user?: string;
  /** ClickHouse HTTP password (`X-ClickHouse-Key`) — the local container
   *  always requires one (`CLICKHOUSE_PASSWORD`, defaulting to
   *  `local-dev-token` from `AE_SQL_TOKEN`); the API worker passes
   *  `env.AE_SQL_TOKEN`.
   *  Measured: with no credentials sent at all, the local
   *  container answers the insert with a non-2xx auth error, which a version
   *  of this sink that only checked "did `fetch` throw" swallowed —
   *  `writeDataPoint` resolved, `SELECT count()` on the table read `0`. Omit
   *  only against a ClickHouse that genuinely has no auth configured. */
  password?: string;
}

/**
 * Local-mode sink (§10): ClickHouse at `http://localhost:8123`, table
 * `runner_events` with the §4 columns plus `timestamp`/`_sample_interval`
 * (DDL in `containers/o11y/local/clickhouse-init.sql`).
 *
 * `timestamp` is sent as a raw epoch-millisecond integer
 * (`clickhouseTimestamp`), not a formatted string: a `DateTime64(3)` column
 * reads a plain integer as milliseconds (not seconds), and a formatted
 * string is parsed in the SERVER's configured timezone — measured 9 hours
 * off under a `session_timezone` override. A unit-less epoch-ms integer is
 * immune to both.
 *
 * Authenticates and rejects on a non-2xx response (measured: no
 * credentials gets `403` from the local container); credentials are sent
 * whenever `options.user`/`.password` are given.
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
