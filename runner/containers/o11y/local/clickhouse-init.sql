-- docs/observability-contract.md §4, §10. Local stand-in for the Workers
-- Analytics Engine `runner_events` dataset: the SAME columns the real AE SQL
-- API answers with (index1, blob1-20, double1-20, timestamp,
-- _sample_interval), so the o11y worker's one allowlisting SQL helper
-- (ADR-0041 §4 "Reading rule") runs unmodified against either backend. Do
-- NOT rename these to the §4 table's friendly names (metric, service_name,
-- ...) — that column mapping lives in the query helper, not the schema.
CREATE DATABASE IF NOT EXISTS default;

CREATE TABLE IF NOT EXISTS default.runner_events
(
    `timestamp`         DateTime64(3) DEFAULT now64(3),
    `index1`            String,
    `blob1`             String DEFAULT '',
    `blob2`             String DEFAULT '',
    `blob3`             String DEFAULT '',
    `blob4`             String DEFAULT '',
    `blob5`             String DEFAULT '',
    `blob6`             String DEFAULT '',
    `blob7`             String DEFAULT '',
    `blob8`             String DEFAULT '',
    `blob9`             String DEFAULT '',
    `blob10`            String DEFAULT '',
    `blob11`            String DEFAULT '',
    `blob12`            String DEFAULT '',
    `blob13`            String DEFAULT '',
    `blob14`            String DEFAULT '',
    `blob15`            String DEFAULT '',
    `blob16`            String DEFAULT '',
    `blob17`            String DEFAULT '',
    `blob18`            String DEFAULT '',
    `blob19`            String DEFAULT '',
    `blob20`            String DEFAULT '',
    `double1`           Float64 DEFAULT 0,
    `double2`           Float64 DEFAULT 0,
    `double3`           Float64 DEFAULT 0,
    `double4`           Float64 DEFAULT 0,
    `double5`           Float64 DEFAULT 0,
    `double6`           Float64 DEFAULT 0,
    `double7`           Float64 DEFAULT 0,
    `double8`           Float64 DEFAULT 0,
    `double9`           Float64 DEFAULT 0,
    `double10`          Float64 DEFAULT 0,
    `double11`          Float64 DEFAULT 0,
    `double12`          Float64 DEFAULT 0,
    `double13`          Float64 DEFAULT 0,
    `double14`          Float64 DEFAULT 0,
    `double15`          Float64 DEFAULT 0,
    `double16`          Float64 DEFAULT 0,
    `double17`          Float64 DEFAULT 0,
    `double18`          Float64 DEFAULT 0,
    `double19`          Float64 DEFAULT 0,
    `double20`          Float64 DEFAULT 0,
    -- Real AE rows are sampled at write AND read time; the local shim never
    -- samples, so every row carries the AE-equivalent constant. Every count
    -- reads `SUM(_sample_interval * double1)`, never `COUNT()` (§4).
    `_sample_interval`  Float64 DEFAULT 1
)
ENGINE = MergeTree
ORDER BY (index1, timestamp);
