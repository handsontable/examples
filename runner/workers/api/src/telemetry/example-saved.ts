// `example.saved` (ADR-0042 §2, contract §5): written by the API worker when an
// editor Save rebuilds a demo, so a visitor leaving before the slow response
// still counts. The taxonomy is the one the editor opened the demo with.

import { HT_MAJORS, type HotAttrs, type HtMajor } from "@handsontable/demo-runtime/telemetry";

/**
 * The point's attrs, or null when the request carries no editor taxonomy: only
 * the editor sends `exampleHtMajor`, and a save from anywhere else (an API
 * token, a tab still on the previous bundle, which counts the save itself) is
 * not an `example.saved`.
 */
export function exampleSavedAttrs(demoId: string, framework: string, exampleHtMajor: unknown): HotAttrs | null {
  if (typeof exampleHtMajor !== "string" || !(HT_MAJORS as readonly string[]).includes(exampleHtMajor)) return null;
  return { kind: "saved", ref: demoId, framework, ht_major: exampleHtMajor as HtMajor };
}
