// `example.saved` (ADR-0042 §2, contract §5): written by the API worker when an
// editor Save rebuilds a demo, so a visitor leaving before the slow response
// still counts. The taxonomy is the one the editor opened the demo with.

import { HT_MAJORS, type HotAttrs, type HtMajor } from "@handsontable/demo-runtime/telemetry";

/**
 * The point's attrs, or null when the request carries no valid `exampleHtMajor`.
 * What gates the count (contract §5) is a successful save whose request
 * carries a valid `exampleHtMajor`, whoever sends it: the editor sends it
 * only while its own telemetry gate is open, but an API-token caller can send
 * it too and is counted exactly the same way. A caller that omits it is not
 * counted.
 */
export function exampleSavedAttrs(demoId: string, framework: string, exampleHtMajor: unknown): HotAttrs | null {
  if (typeof exampleHtMajor !== "string" || !(HT_MAJORS as readonly string[]).includes(exampleHtMajor)) return null;
  return { kind: "saved", ref: demoId, framework, ht_major: exampleHtMajor as HtMajor };
}
