// resolveRuntime — picks the engine for a catalog entry. Tier 1 -> Sandpack
// (in-browser bundler); Tier 2 -> Cloudflare Sandbox container. The concrete
// SandpackRuntime and ContainerRuntime are implemented in later deliverables
// (2 and 4); this module only decides which one to construct so the shell can
// stay engine-agnostic.

import type { CatalogEntry, DemoRuntime } from "./types.js";

export type RuntimeKind = "sandpack" | "container";

export function resolveRuntimeKind(entry: Pick<CatalogEntry, "tier">): RuntimeKind {
  return entry.tier === 1 ? "sandpack" : "container";
}

export interface RuntimeFactories {
  sandpack: (entry: CatalogEntry) => DemoRuntime;
  container: (entry: CatalogEntry) => DemoRuntime;
}

/**
 * Construct the runtime for an entry using injected factories. Apps wire the two
 * concrete factories once; callers then just pass a catalog entry.
 */
export function resolveRuntime(entry: CatalogEntry, factories: RuntimeFactories): DemoRuntime {
  return factories[resolveRuntimeKind(entry)](entry);
}
