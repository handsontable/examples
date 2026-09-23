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

export interface ClickhouseSinkOptions {
  /** Table name — `runner_events` (§10) by default. */
  table?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Local-mode sink (§10): ClickHouse at `http://localhost:8123` (or wherever
 * `url` points), table `runner_events` with the §4 columns plus `timestamp` and
 * `_sample_interval` (always `1` locally — no real sampling), DDL in
 * `containers/o11y/local/clickhouse-init.sql` (T01). Column names are the AE
 * slot names themselves (`index1`, `blob1`…`blob20`, `double1`…`double20`,
 * T00-D2/T00-D from the task Outcome) — the same query a real Analytics Engine
 * SQL call would run, no second name mapping.
 */
export function clickhouseSink(url: string, options: ClickhouseSinkOptions = {}): AeSink {
  const table = options.table ?? "runner_events";
  const doFetch = options.fetchImpl ?? fetch;
  return {
    writeDataPoint(point: AePoint): Promise<void> {
      const row: Record<string, string | number> = {
        timestamp: Math.floor(Date.now() / 1000),
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
      return doFetch(endpoint, { method: "POST", body: `${JSON.stringify(row)}\n` }).then(() => undefined);
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
