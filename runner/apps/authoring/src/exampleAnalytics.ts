/**
 * ADR-0042 (example analytics) — what a resolved example's `example.*`
 * attribute bag looks like, computed once per real navigation (never per
 * render) at the `App.tsx` example-resolve path (`loadWorkspace`).
 *
 * Import-free, same reason as `tier1Report.ts`/`demoEventReport.ts`: those
 * files pull in packages `node --test` cannot resolve the way `App.tsx`
 * does, so the decision logic is split out here to stay unit-testable by
 * `pipeline/example-analytics-taxonomy.test.mjs`. `HotAttrs`'s `ht_major`/
 * `framework`/etc. types are mirrored structurally as plain `string`, not
 * imported, for the same reason.
 */

/** ADR-0042 §1's closed `kind` set. */
export type ExampleKind = "docs" | "starter" | "saved" | "import" | "payload";

/** ADR-0042 §1's closed `entry`/`reason` set for `example.open` only —
 *  `example.engaged`/`.forked`/`.saved`/`.shared`/`.downloaded` carry no
 *  `reason` at all (§5: `EXAMPLE_ACTION`'s blobs list excludes it, and
 *  `toAePoint` throws if a caller sets `reason` on a metric with no such
 *  slot). */
export type ExampleOpenReason = "deep-link" | "picker" | "switch" | "version-switch" | "fork";

/** `App.tsx`'s `loadWorkspace(nextEntry, nextFiles, lineage)` lineage
 *  prefixes (DEV-2859's own redaction comment names them): `catalog:<fw>`,
 *  `docs:<bucket>:<path>`, `import:<provider>`, `payload:<source>`, or a
 *  bare saved-demo id carrying no colon at all. */
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

/** The loaded docs-example manifest entry's fields `example.*` needs —
 *  `guide` (130 unique guides, the "top guides" grouping key — NOT
 *  `docsPath`, which is per-example and, for a deep link, comes straight off
 *  the URL, which the task's own Traps forbid reading taxonomy from),
 *  `breadcrumb[0]` (area) and `framework` (already distinguishes JS/TS). */
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
  /** `entry.framework` — used for every kind except `docs`, where the
   *  loaded docs-example entry's own `framework` is more precise (it
   *  already distinguishes a JS example from its TS variant, ADR-0042 §1). */
  framework: string;
  /** `hot.ht_major` already resolved by the caller (`selectedReleaseMajor`/
   *  `isNextPrereleaseVersion`, both `@handsontable/demo-runtime` — kept out
   *  of this file's own imports). */
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
 *  event that carries `reason` (contract §5: `example.open`'s row alone
 *  lists it among its blobs). Empty strings for `area`/`bucket` are left out
 *  rather than sent as `""`: `toAePoint` writes an empty blob for a column
 *  it never receives, and an omitted key is indistinguishable from that at
 *  ingest, so this is purely about not shipping a needless empty header. */
export function exampleOpenAttrs(taxonomy: ExampleTaxonomy, reason: ExampleOpenReason): Record<string, string> {
  return { ...exampleActionAttrs(taxonomy), reason };
}

/** `Telemetry.event("example.<action>", ...)`'s attrs for every OTHER
 *  `example.*` metric (`engaged`/`forked`/`saved`/`shared`/`downloaded`,
 *  contract §5's `EXAMPLE_ACTION` row) — no `reason` field, since none of
 *  their registry rows list one and `toAePoint` throws if it is sent anyway. */
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

/** Dedup key for "one `example.open` per resolved example, none on
 *  re-render" — an effect that re-runs for an unrelated reason (a
 *  `nextVersion` resolve, a `versionsResolved` flip) must not re-fire the
 *  same open. Keyed on the lineage plus the pinned HT version: identical
 *  lineage + identical version is the same open; identical lineage with a
 *  different version is a real `version-switch`. */
export function exampleOpenKey(lineage: string, version: string): string {
  return `${lineage}\u0000${version}`;
}
