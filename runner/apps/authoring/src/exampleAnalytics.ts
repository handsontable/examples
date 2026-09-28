/**
 * ADR-0042 (example analytics) — the resolved example's `example.*`
 * attribute bag, computed once per real navigation at `App.tsx`'s
 * `loadWorkspace`. Import-free so it stays unit-testable directly.
 */

/** ADR-0042 §1's closed `kind` set. */
export type ExampleKind = "docs" | "starter" | "saved" | "import" | "payload";

/** ADR-0042 §1's closed `entry`/`reason` set for `example.open` only —
 *  other `example.*` events carry no `reason` (`toAePoint` throws if set). */
export type ExampleOpenReason = "deep-link" | "picker" | "switch" | "version-switch" | "fork";

/** `App.tsx`'s `loadWorkspace` lineage prefixes: `catalog:<fw>`,
 *  `docs:<bucket>:<path>`, `import:<provider>`, `payload:<source>`, or a
 *  bare saved-demo id with no colon. */
export function kindOfLineage(lineage: string): ExampleKind {
  const colon = lineage.indexOf(":");
  const prefix = colon === -1 ? "" : lineage.slice(0, colon);
  switch (prefix) {
    case "catalog":
      return "starter";
    case "docs":
      return "docs";
    case "import":
      return "import";
    case "payload":
      return "payload";
    default:
      // No colon (or an unrecognised prefix, which never happens in
      // practice): a saved demo's id is the lineage's entire value.
      return "saved";
  }
}

/** The loaded docs-example manifest fields `example.*` needs: `guide` (the
 *  "top guides" grouping key, not `docsPath`), `breadcrumb[0]` (area) and
 *  `framework`. */
export interface DocsExampleMeta {
  guide: string;
  area: string;
  framework: string;
}

export interface ExampleTaxonomy {
  kind: ExampleKind;
  ref: string;
  area?: string;
  framework: string;
  ht_major: string;
  bucket?: string;
}

export interface ExampleTaxonomyInput {
  /** The exact `lineage` string passed to `loadWorkspace`. */
  lineage: string;
  /** `entry.framework` — except for `docs`, where the loaded docs-example
   *  entry's own `framework` is more precise (distinguishes JS/TS). */
  framework: string;
  /** `hot.ht_major` already resolved by the caller. */
  htMajor: string;
  /** The docs/starter bucket in play (`18.1`, `next`, …), when known. */
  bucket?: string;
  /** Present only when `kindOfLineage(lineage) === "docs"`. */
  docs?: DocsExampleMeta;
}

/** Builds the taxonomy once per `loadWorkspace` call. `ref` is `guide` for a
 *  docs example (not `docsPath`/the URL), the framework id for a starter,
 *  the saved-demo id for a saved reopen, and the lineage's own suffix for an
 *  import/payload workspace (its provider/source — there is no guide-style
 *  identifier for either). `area` is set only for `docs` (ADR-0042 §1: "not
 *  derivable from `ref`" — a starter/saved/import/payload example has none). */
export function exampleTaxonomy(input: ExampleTaxonomyInput): ExampleTaxonomy {
  const kind = kindOfLineage(input.lineage);
  const colon = input.lineage.indexOf(":");
  const rest = colon === -1 ? input.lineage : input.lineage.slice(colon + 1);

  switch (kind) {
    case "docs":
      return {
        kind,
        ref: input.docs?.guide ?? rest,
        area: input.docs?.area,
        framework: input.docs?.framework ?? input.framework,
        ht_major: input.htMajor,
        bucket: input.bucket,
      };
    case "starter":
      return { kind, ref: input.framework, framework: input.framework, ht_major: input.htMajor, bucket: input.bucket };
    case "import":
    case "payload":
      return {
        kind,
        ref: rest || kind,
        framework: input.framework,
        ht_major: input.htMajor,
        bucket: input.bucket,
      };
    case "saved":
    default:
      return { kind, ref: input.lineage, framework: input.framework, ht_major: input.htMajor, bucket: input.bucket };
  }
}

/** `Telemetry.event("example.open", ...)`'s attrs — the only `example.*`
 *  event carrying `reason` (contract §5). Empty `area`/`bucket` are
 *  omitted rather than sent as `""`. */
export function exampleOpenAttrs(taxonomy: ExampleTaxonomy, reason: ExampleOpenReason): Record<string, string> {
  return { ...exampleActionAttrs(taxonomy), reason };
}

/** `Telemetry.event("example.<action>", ...)`'s attrs for every OTHER
 *  `example.*` metric — no `reason` field (`toAePoint` throws if sent). */
export function exampleActionAttrs(taxonomy: ExampleTaxonomy): Record<string, string> {
  const out: Record<string, string> = {
    kind: taxonomy.kind,
    ref: taxonomy.ref,
    framework: taxonomy.framework,
    ht_major: taxonomy.ht_major,
  };
  if (taxonomy.area) out.area = taxonomy.area;
  if (taxonomy.bucket) out.bucket = taxonomy.bucket;
  return out;
}

/** ADR-0042 — the one-shot URL marker `onFork`'s navigation leaves behind,
 *  so the saved-demo load effect can classify the landing as `fork`. Not
 *  browser storage: a full-reload navigation destroys any in-memory flag. */
export const FORK_LANDING_PARAM = "fork";

/**
 * Reads whether `search` carries the one-shot fork marker, and returns
 * `search` with it removed. The caller writes that back via
 * `history.replaceState` before anything async runs, so a reload or a
 * second effect run never re-reads it (idempotent). Pure — no
 * `URL`/`history` access — so this is unit-testable without a browser.
 */
export function consumeForkMarker(search: string): { isFork: boolean; search: string } {
  const params = new URLSearchParams(search);
  if (!params.has(FORK_LANDING_PARAM)) return { isFork: false, search };
  params.delete(FORK_LANDING_PARAM);
  const rest = params.toString();
  return { isFork: true, search: rest ? `?${rest}` : "" };
}

/** Dedup key for "one `example.open` per resolved example, none on
 *  re-render" — keyed on lineage + pinned HT version, so a version change
 *  is a real `version-switch`, not a re-fire. */
export function exampleOpenKey(lineage: string, version: string): string {
  return `${lineage}\u0000${version}`;
}
