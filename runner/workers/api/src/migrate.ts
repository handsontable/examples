// render-ms compatibility shim (D8, ADR-0017). Maps old public deep links
// (/codesandbox-vm, /codesandbox-browser with example-dir + handsontable-version)
// to the new system: build-or-reuse a PUBLIC static render of (example, version)
// from the catalog and redirect to /d/:id. Deterministic id per (example,
// version) so links are stable; first hit builds, subsequent hits are instant.

import catalog from "../../../catalog.json";
import { applyHandsontableVersion, validateHandsontableVersion, type HandsontableVersionRef } from "@handsontable/demo-runtime";
import { BUILD_CONFIG } from "./frameworks.generated.js";
import { createDemo, getDemo } from "./share.js";
import type { Env } from "./env.js";

interface CatalogShape {
  examples: Array<{ framework: string; files: Record<string, string> }>;
}
const CAT = catalog as unknown as CatalogShape;

/** Resolve a version input to a ref; "latest"/empty -> npm dist-tag lookup. */
export async function resolveVersion(input: string | null): Promise<HandsontableVersionRef> {
  const raw = (input ?? "").trim();
  if (raw && raw.toLowerCase() !== "latest") {
    const v = validateHandsontableVersion(raw);
    if (v.ok) return v.value;
  }
  try {
    const r = await fetch("https://registry.npmjs.org/handsontable/latest");
    if (r.ok) {
      const j = (await r.json()) as { version?: string };
      if (j.version) {
        const v = validateHandsontableVersion(j.version);
        if (v.ok) return v.value;
      }
    }
  } catch {
    /* fall through */
  }
  return { ref: "latest", pkgPrNew: false };
}

export type RenderResult = { id: string } | { error: string; status: number };

/** Build-or-reuse a public render of (exampleDir, version); returns its /d id. */
export async function renderMs(
  env: Env,
  exampleDir: string,
  versionInput: string | null,
  now: string,
): Promise<RenderResult> {
  const ex = CAT.examples.find((e) => e.framework === exampleDir);
  const cfg = BUILD_CONFIG[exampleDir];
  if (!ex || !cfg) return { error: `unknown example-dir: ${exampleDir}`, status: 400 };

  const version = await resolveVersion(versionInput);
  const id = `r-${exampleDir}-${version.ref}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 48);

  const existing = await getDemo(env, id);
  if (existing && !existing.revoked) return { id };

  const files = version.ref === "latest" ? ex.files : applyHandsontableVersion(ex.files, version);
  try {
    await createDemo(env, {
      entry: { framework: exampleDir, ...cfg },
      files,
      htVersion: version.ref,
      title: `${exampleDir} @ ${version.ref}`,
      description: "Migrated from a render-ms deep link.",
      createdBy: "render-ms-compat",
      forkedFrom: `catalog:${exampleDir}`,
      now,
      id,
      visibility: "public",
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), status: 500 };
  }
  return { id };
}
