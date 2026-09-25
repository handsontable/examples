// Hand-rolled OTLP `ExportLogsServiceRequest` protobuf decoder, wire-primitive
// only (`@bufbuild/protobuf/wire`'s `BinaryReader`, no generated/reflective
// message types — T00's pinned choice, see its task Outcome: `protobufjs`'s
// reflective decode path uses `new Function(...)`, which Workers disallows by
// default). Decodes into the same flat shape `otlp-json.ts` produces from the
// JSON variant, so `normalise/otlp.ts` has one shared "what to do with a
// decoded ResourceLogs" step regardless of which wire format arrived — the
// sandbox probe was meant to observe which one Cloudflare's own log export
// actually sends (see this task's Outcome for what the probe recorded).
//
// Proto shapes decoded (github.com/open-telemetry/opentelemetry-proto,
// `opentelemetry/proto/{logs,common,resource}/v1`), only the fields this
// contract reads:
//
//   ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
//   ResourceLogs             { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
//   Resource                 { repeated KeyValue attributes = 1; }
//   ScopeLogs                { repeated LogRecord log_records = 2; }
//   LogRecord                { fixed64 time_unix_nano = 1; fixed64 observed_time_unix_nano = 11;
//                              string severity_text = 3; AnyValue body = 5;
//                              repeated KeyValue attributes = 6; }
//   KeyValue                 { string key = 1; AnyValue value = 2; }
//   AnyValue                 { string string_value = 1; bool bool_value = 2; int64 int_value = 3;
//                              double double_value = 4; bytes bytes_value = 7; }  (oneof)
//
// T02-D — only scalar `AnyValue` kinds are decoded to a string (see the task
// Outcome): `array_value`/`kvlist_value` (nested `AnyValue` collections) are
// rendered as `"[unsupported: array]"`/`"[unsupported: kvlist]"` rather than
// recursively decoded — no fixture or probe capture observed a nested value
// under `hot.*`/`service.*`/`deployment.*` (the only attributes this
// contract keeps), and every allowlisted key is a plain string by contract.

import { BinaryReader } from "@bufbuild/protobuf/wire";

export interface DecodedLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityText?: string;
  body?: string;
  attributes: Record<string, string>;
}

export interface DecodedResourceLogs {
  resourceAttributes: Record<string, string>;
  logRecords: DecodedLogRecord[];
}

function anyValueToString(bytes: Uint8Array): string {
  const r = new BinaryReader(bytes);
  while (r.pos < r.len) {
    const [fieldNo, wireType] = r.tag();
    switch (fieldNo) {
      case 1: // string_value
        return r.string();
      case 2: // bool_value
        return String(r.bool());
      case 3: // int_value
        return String(r.int64());
      case 4: // double_value
        return String(r.double());
      case 7: // bytes_value
        return btoa(String.fromCharCode(...r.bytes()));
      case 5:
        r.skip(wireType);
        return "[unsupported: array]";
      case 6:
        r.skip(wireType);
        return "[unsupported: kvlist]";
      default:
        r.skip(wireType);
    }
  }
  return "";
}

function readKeyValue(bytes: Uint8Array): [string, string] {
  const r = new BinaryReader(bytes);
  let key = "";
  let value = "";
  while (r.pos < r.len) {
    const [fieldNo, wireType] = r.tag();
    if (fieldNo === 1) key = r.string();
    else if (fieldNo === 2) value = anyValueToString(r.bytes());
    else r.skip(wireType);
  }
  return [key, value];
}

function readAttributes(r: BinaryReader): Record<string, string> {
  const out: Record<string, string> = {};
  while (r.pos < r.len) {
    const [fieldNo, wireType] = r.tag();
    if (fieldNo === 1) {
      const [k, v] = readKeyValue(r.bytes());
      out[k] = v;
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

function readLogRecord(bytes: Uint8Array): DecodedLogRecord {
  const r = new BinaryReader(bytes);
  const rec: DecodedLogRecord = { attributes: {} };
  while (r.pos < r.len) {
    const [fieldNo, wireType] = r.tag();
    switch (fieldNo) {
      case 1:
        rec.timeUnixNano = String(r.fixed64());
        break;
      case 11:
        rec.observedTimeUnixNano = String(r.fixed64());
        break;
      case 3:
        rec.severityText = r.string();
        break;
      case 5:
        rec.body = anyValueToString(r.bytes());
        break;
      case 6: {
        const [k, v] = readKeyValue(r.bytes());
        rec.attributes[k] = v;
        break;
      }
      default:
        r.skip(wireType);
    }
  }
  return rec;
}

function readScopeLogs(bytes: Uint8Array, out: DecodedLogRecord[]): void {
  const r = new BinaryReader(bytes);
  while (r.pos < r.len) {
    const [fieldNo, wireType] = r.tag();
    if (fieldNo === 2) out.push(readLogRecord(r.bytes()));
    else r.skip(wireType);
  }
}

function readResourceLogs(bytes: Uint8Array): DecodedResourceLogs {
  const r = new BinaryReader(bytes);
  const out: DecodedResourceLogs = { resourceAttributes: {}, logRecords: [] };
  while (r.pos < r.len) {
    const [fieldNo, wireType] = r.tag();
    if (fieldNo === 1) {
      // Resource { repeated KeyValue attributes = 1; }
      const resourceBytes = r.bytes();
      const rr = new BinaryReader(resourceBytes);
      out.resourceAttributes = readAttributes(rr);
    } else if (fieldNo === 2) {
      readScopeLogs(r.bytes(), out.logRecords);
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

/** Decodes an `ExportLogsServiceRequest` protobuf body into a flat list of
 *  {@link DecodedResourceLogs}. Throws on a truncated/malformed body — the
 *  caller (`normalise/otlp.ts`) turns that into a `400`, never a `500`. */
export function decodeOtlpProtobuf(bytes: Uint8Array): DecodedResourceLogs[] {
  const r = new BinaryReader(bytes);
  const out: DecodedResourceLogs[] = [];
  while (r.pos < r.len) {
    const [fieldNo, wireType] = r.tag();
    if (fieldNo === 1) out.push(readResourceLogs(r.bytes()));
    else r.skip(wireType);
  }
  return out;
}
