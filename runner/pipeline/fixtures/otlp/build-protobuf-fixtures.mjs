#!/usr/bin/env node
// Hand-encodes the OTLP `ExportLogsServiceRequest` protobuf fixtures this
// task's tests replay (`pipeline/o11y-normalise.test.mjs`,
// `scripts/o11y-replay-fixtures.mjs`) — the binary-wire mirror of
// `pipeline/fixtures/otlp/json/basic.json` and `.../zero-timestamp.json`,
// same field values, so the two decoders (`workers/o11y/src/normalise/otlp.ts`'s
// `decodeOtlpJson` / `otlp-protobuf.ts`'s `decodeOtlpProtobuf`) can be tested
// against equivalent inputs. Uses `@bufbuild/protobuf/wire`'s `BinaryWriter`
// only — the same wire-primitive-only choice T00 pinned for the decoder
// (see its task Outcome). Every `repeated` field is written as one
// tag+length-prefix *per element* (protobuf's actual wire rule) — a first
// draft of this script wrapped a whole loop's worth of elements in one
// shared fork, which round-tripped as garbage; fixed after decoding the
// output with `decodeOtlpProtobuf` and finding concatenated garbled keys.
//
// Regenerate: `node --experimental-strip-types
// pipeline/fixtures/otlp/build-protobuf-fixtures.mjs`, run with a `cwd`
// inside `workers/o11y` (or `NODE_PATH` pointing at its `node_modules`) so
// `@bufbuild/protobuf` resolves — it is that Worker's dependency, not the
// pipeline's. Output committed — these are fixtures, not build artifacts.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

/** Writes an `AnyValue` message's contents (just `string_value = 1`, the
 *  only kind these fixtures need). */
function anyValueString(w, value) {
  w.tag(1, WireType.LengthDelimited).string(value);
}

/** Writes a `KeyValue` message's contents: `key = 1`, `value = 2` (AnyValue). */
function keyValueContents(w, key, value) {
  w.tag(1, WireType.LengthDelimited).string(key);
  w.tag(2, WireType.LengthDelimited).fork();
  anyValueString(w, value);
  w.join();
}

/** Writes one `repeated KeyValue` element at `fieldNo` — each element of a
 *  repeated message field gets its **own** tag + length prefix; this is the
 *  bug the file header describes fixing. */
function writeKeyValue(w, fieldNo, key, value) {
  w.tag(fieldNo, WireType.LengthDelimited).fork();
  keyValueContents(w, key, value);
  w.join();
}

function writeLogRecord(w, fieldNo, { timeUnixNano, observedTimeUnixNano, body, attrs }) {
  w.tag(fieldNo, WireType.LengthDelimited).fork();
  if (timeUnixNano !== undefined) w.tag(1, WireType.Bit64).fixed64(BigInt(timeUnixNano));
  if (observedTimeUnixNano !== undefined) w.tag(11, WireType.Bit64).fixed64(BigInt(observedTimeUnixNano));
  w.tag(5, WireType.LengthDelimited).fork(); // body = 5 (AnyValue)
  anyValueString(w, body);
  w.join();
  for (const [k, v] of attrs) writeKeyValue(w, 6, k, v); // attributes = 6
  w.join();
}

function writeScopeLogs(w, fieldNo, records) {
  w.tag(fieldNo, WireType.LengthDelimited).fork();
  for (const record of records) writeLogRecord(w, 2, record); // log_records = 2
  w.join();
}

function writeResource(w, fieldNo, attrs) {
  w.tag(fieldNo, WireType.LengthDelimited).fork();
  for (const [k, v] of attrs) writeKeyValue(w, 1, k, v); // attributes = 1
  w.join();
}

function writeResourceLogs(w, fieldNo, { resourceAttrs, records }) {
  w.tag(fieldNo, WireType.LengthDelimited).fork();
  writeResource(w, 1, resourceAttrs); // resource = 1
  writeScopeLogs(w, 2, records); // scope_logs = 2
  w.join();
}

function build(resourceAttrs, records) {
  const w = new BinaryWriter();
  writeResourceLogs(w, 1, { resourceAttrs, records }); // ExportLogsServiceRequest.resource_logs = 1
  return w.finish();
}

const basic = build(
  [
    ["service.name", "demos-api"],
    ["service.version", "cafef00d"],
    ["deployment.environment.name", "production"],
  ],
  [
    {
      timeUnixNano: "1735689600000000000",
      body: "api.request route=api/demos status=200 (protobuf)",
      attrs: [
        ["hot.surface", "api"],
        ["hot.outcome", "2xx"],
        ["cf.ray", "8a1b2c3d4e5f6789"],
      ],
    },
  ],
);

const zeroTimestamp = build(
  [
    ["service.name", "demos-api"],
    ["service.version", "cafef00d"],
    ["deployment.environment.name", "production"],
  ],
  [
    {
      timeUnixNano: "0",
      observedTimeUnixNano: "0",
      body: "a protobuf record with no real timestamp, exit criterion 3",
      attrs: [["hot.surface", "api"]],
    },
  ],
);

const dir = fileURLToPath(new URL(".", import.meta.url));
writeFileSync(`${dir}protobuf/basic.bin`, basic);
writeFileSync(`${dir}protobuf/zero-timestamp.bin`, zeroTimestamp);
console.log(`wrote ${basic.byteLength} bytes to protobuf/basic.bin`);
console.log(`wrote ${zeroTimestamp.byteLength} bytes to protobuf/zero-timestamp.bin`);
