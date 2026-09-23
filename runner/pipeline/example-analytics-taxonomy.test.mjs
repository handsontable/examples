// ADR-0042 — pins `apps/authoring/src/exampleAnalytics.ts`'s pure taxonomy
// logic: which `loadWorkspace` lineage maps to which `kind`, and what `ref`/
// `area`/`framework` a resolved example carries — read from the loaded
// docs-example entry, never from the URL (the task's own Traps).
//
// Run: node --experimental-strip-types --test pipeline/example-analytics-taxonomy.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeForkMarker,
  exampleActionAttrs,
  exampleOpenAttrs,
  exampleOpenKey,
  exampleTaxonomy,
  kindOfLineage,
} from "../apps/authoring/src/exampleAnalytics.ts";

// ---- kindOfLineage -------------------------------------------------------------

test("kindOfLineage: every loadWorkspace lineage prefix", () => {
  assert.equal(kindOfLineage("catalog:react"), "starter");
  assert.equal(kindOfLineage("docs:18.1:guides/accessibility/accessibility/react/example1.tsx"), "docs");
  assert.equal(kindOfLineage("import:jsfiddle"), "import");
  assert.equal(kindOfLineage("payload:theme-builder"), "payload");
  // A saved demo's id carries no colon at all (DEV-2859's own redaction rule).
  assert.equal(kindOfLineage("dem0-abc123"), "saved");
  assert.equal(kindOfLineage(""), "saved");
});

// ---- exampleTaxonomy: docs -----------------------------------------------------

test("exampleTaxonomy(docs): ref is the guide, not docsPath or the URL", () => {
  const taxonomy = exampleTaxonomy({
    lineage: "docs:18.1:guides/accessibility/accessibility/react/example1.tsx",
    framework: "react", // the app's own catalog framework — must be overridden below
    htMajor: "18",
    bucket: "18.1",
    docs: {
      guide: "guides/accessibility/accessibility/accessibility.md",
      area: "Accessibility",
      framework: "reactts",
    },
  });
  assert.deepEqual(taxonomy, {
    kind: "docs",
    ref: "guides/accessibility/accessibility/accessibility.md",
    area: "Accessibility",
    framework: "reactts", // read from the loaded entry, not the app's own `framework`
    ht_major: "18",
    bucket: "18.1",
  });
});

test("exampleTaxonomy(docs): falls back to the lineage suffix when no entry is given", () => {
  const taxonomy = exampleTaxonomy({
    lineage: "docs:18.1:guides/x/x/react/example1.tsx",
    framework: "react",
    htMajor: "18",
  });
  assert.equal(taxonomy.ref, "18.1:guides/x/x/react/example1.tsx");
  assert.equal(taxonomy.area, undefined);
  assert.equal(taxonomy.framework, "react");
});

// ---- exampleTaxonomy: starter/saved/import/payload -----------------------------

test("exampleTaxonomy(starter): ref is the framework id, no area", () => {
  const taxonomy = exampleTaxonomy({ lineage: "catalog:vue3", framework: "vue3", htMajor: "18", bucket: "18.1" });
  assert.deepEqual(taxonomy, { kind: "starter", ref: "vue3", framework: "vue3", ht_major: "18", bucket: "18.1" });
});

test("exampleTaxonomy(saved): ref is the demo id", () => {
  const taxonomy = exampleTaxonomy({ lineage: "dem0-xyz", framework: "react", htMajor: "next" });
  assert.equal(taxonomy.kind, "saved");
  assert.equal(taxonomy.ref, "dem0-xyz");
  assert.equal(taxonomy.area, undefined);
  assert.equal(taxonomy.bucket, undefined);
});

test("exampleTaxonomy(import/payload): ref is the lineage's own suffix", () => {
  assert.equal(
    exampleTaxonomy({ lineage: "import:jsfiddle", framework: "react", htMajor: "18" }).ref,
    "jsfiddle",
  );
  assert.equal(
    exampleTaxonomy({ lineage: "payload:theme-builder", framework: "react", htMajor: "18" }).ref,
    "theme-builder",
  );
});

// ---- exampleOpenAttrs / exampleActionAttrs -------------------------------------

test("exampleOpenAttrs: carries reason, exampleActionAttrs does not", () => {
  const taxonomy = exampleTaxonomy({
    lineage: "docs:18.1:guides/x/x/react/example1.tsx",
    framework: "react",
    htMajor: "18",
    bucket: "18.1",
    docs: { guide: "guides/x/x/x.md", area: "Columns", framework: "react" },
  });
  const open = exampleOpenAttrs(taxonomy, "deep-link");
  assert.equal(open.reason, "deep-link");
  assert.equal(open.kind, "docs");
  assert.equal(open.ref, "guides/x/x/x.md");
  assert.equal(open.area, "Columns");
  assert.equal(open.bucket, "18.1");

  const action = exampleActionAttrs(taxonomy);
  assert.equal("reason" in action, false, "example.engaged/forked/saved/shared/downloaded carry no reason");
  assert.equal(action.kind, "docs");
});

test("exampleActionAttrs: omits area/bucket when the taxonomy has none, never sends an empty string", () => {
  const taxonomy = exampleTaxonomy({ lineage: "catalog:react", framework: "react", htMajor: "18" });
  const attrs = exampleActionAttrs(taxonomy);
  assert.equal("area" in attrs, false);
  assert.equal("bucket" in attrs, false);
});

// ---- exampleOpenKey (dedup) -----------------------------------------------------

test("exampleOpenKey: same lineage + same version is the same key; a version change is a different key", () => {
  const a = exampleOpenKey("docs:18.1:guides/x/x/react/example1.tsx", "18.1.2");
  const b = exampleOpenKey("docs:18.1:guides/x/x/react/example1.tsx", "18.1.2");
  const c = exampleOpenKey("docs:18.1:guides/x/x/react/example1.tsx", "18.1.3");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---- consumeForkMarker (T12-D2 fix round: entry=fork) ---------------------------
//
// onFork navigates with a full `location.href` reload (App.tsx's own
// established pattern for every route change — /my-demos, /admin, /guide,
// etc. — never client-side routing), which destroys every in-memory flag, so
// the one-shot signal has to survive in the URL itself, stripped on read.
// Never localStorage/sessionStorage (the contract keeps this path off
// browser storage).

test("consumeForkMarker: detects the marker and strips it down to an empty search", () => {
  const { isFork, search } = consumeForkMarker("?fork=1");
  assert.equal(isFork, true);
  assert.equal(search, "");
});

test("consumeForkMarker: strips only the marker, keeps other params", () => {
  const { isFork, search } = consumeForkMarker("?v=18.0.0&fork=1");
  assert.equal(isFork, true);
  assert.equal(search, "?v=18.0.0");
});

test("consumeForkMarker: no marker present -> isFork false, search returned unchanged", () => {
  const { isFork, search } = consumeForkMarker("?v=18.0.0");
  assert.equal(isFork, false);
  assert.equal(search, "?v=18.0.0");
});

test("consumeForkMarker: empty search -> isFork false, still an empty search", () => {
  const { isFork, search } = consumeForkMarker("");
  assert.equal(isFork, false);
  assert.equal(search, "");
});

test("consumeForkMarker: one-shot -- reading the stripped search a second time no longer counts as fork", () => {
  const first = consumeForkMarker("?fork=1");
  const second = consumeForkMarker(first.search);
  assert.equal(first.isFork, true);
  assert.equal(second.isFork, false, "a manual reload of the same (already-stripped) URL must not re-count as a fork");
});
