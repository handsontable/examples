// `example.saved` (ADR-0042 §2, contract §5): written by the API worker when an
// editor Save rebuilds a demo, so a visitor leaving before the slow response
// still counts. The point is attributed to the example the demo came from, not
// to the demo itself, so the Examples funnel can show saves per area.

import { HT_MAJORS, type HotAttrs, type HtMajor } from "@handsontable/demo-runtime/telemetry";
import { DOCS_GUIDES, DOCS_PATH_GUIDE } from "../docs-taxonomy.generated.js";

/** How many saved-demo hops a lineage is followed through (a fork of a fork of ...). */
const MAX_LINEAGE_HOPS = 5;

export interface ExampleSource {
  kind: "docs" | "starter" | "import" | "payload";
  ref: string;
  area?: string;
  bucket?: string;
}

/**
 * The example a `forked_from` lineage names, or null when it names none this
 * can resolve. Mirrors the browser's `exampleTaxonomy` (`ref` is the docs
 * guide, the starter's framework key, the import/payload source) so a save
 * lands on the same row its `example.open` did. `mcp:` is not an example, and
 * a docs path missing from the bundled taxonomy is unknown, not guessed.
 * A bare id (no colon) is a saved demo: `loadParent` reads that demo's own
 * `forked_from`, up to `MAX_LINEAGE_HOPS`, with a cycle guard.
 */
export async function resolveExampleSource(
  forkedFrom: string | null | undefined,
  loadParent: (demoId: string) => Promise<string | null | undefined>,
): Promise<ExampleSource | null> {
  const seen = new Set<string>();
  let lineage = forkedFrom;
  for (let hop = 0; hop <= MAX_LINEAGE_HOPS; hop++) {
    if (!lineage) return null;
    const colon = lineage.indexOf(":");
    if (colon === -1) {
      if (seen.has(lineage)) return null;
      seen.add(lineage);
      lineage = await loadParent(lineage);
      continue;
    }
    const prefix = lineage.slice(0, colon);
    const rest = lineage.slice(colon + 1);
    switch (prefix) {
      case "catalog":
        return rest ? { kind: "starter", ref: rest } : null;
      case "import":
      case "payload":
        return { kind: prefix, ref: rest || prefix };
      case "docs": {
        // `docs:<bucket>:<docsPath>`; a save before 2026-07-17 carried `docs:<docsPath>`.
        const split = rest.indexOf(":");
        const bucket = split === -1 ? undefined : rest.slice(0, split);
        const docsPath = split === -1 ? rest : rest.slice(split + 1);
        const guideAt = Object.hasOwn(DOCS_PATH_GUIDE, docsPath) ? DOCS_PATH_GUIDE[docsPath] : undefined;
        const guide = guideAt === undefined ? undefined : DOCS_GUIDES[guideAt];
        if (!guide) return null;
        return { kind: "docs", ref: guide[0], area: guide[1] || undefined, ...(bucket ? { bucket } : {}) };
      }
      default:
        return null;
    }
  }
  return null;
}

/**
 * The point's attrs, or null when the request carries no valid `exampleHtMajor`.
 * What gates the count (contract §5) is a successful save whose request
 * carries a valid `exampleHtMajor`, whoever sends it: the editor sends it
 * only while its own telemetry gate is open, but an API-token caller can send
 * it too and is counted exactly the same way. A caller that omits it is not
 * counted.
 *
 * With a resolved `source` the save is attributed to that example; without
 * one it stays `kind=saved, ref=<demo id>`.
 */
export function exampleSavedAttrs(
  demoId: string,
  framework: string,
  exampleHtMajor: unknown,
  source: ExampleSource | null = null,
): HotAttrs | null {
  if (typeof exampleHtMajor !== "string" || !(HT_MAJORS as readonly string[]).includes(exampleHtMajor)) return null;
  const ht_major = exampleHtMajor as HtMajor;
  if (!source) return { kind: "saved", ref: demoId, framework, ht_major };
  return {
    kind: source.kind,
    ref: source.ref,
    framework,
    ht_major,
    ...(source.area ? { area: source.area } : {}),
    ...(source.bucket ? { bucket: source.bucket } : {}),
  };
}
