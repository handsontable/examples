// The one place that knows what the snapshot builder actually runs. A leaf on
// purpose: both `share.ts` (which runs it) and `mcp-create.ts` (which asks what
// binary it will invoke) import it, and `mcp-create.ts` must stay import-free of
// the Worker's heavy modules (see its own header comment).

/** The build command as the snapshot builder runs it: the leading type-check step is
 *  stripped, because snapshots need the bundle, not type-checking. */
export function snapshotBuildCommand(buildCommand: string): string {
  return buildCommand.replace(/^\s*(tsc(\s+-b)?|vue-tsc[^&]*)\s*&&\s*/i, "");
}

/**
 * Does this framework's HTML entry declare the module that boots the demo? (DEV-2741)
 *
 * Vite's contract for an HTML entry is exactly that: the document is the entry, and the
 * module graph is whatever its `<script type="module" src>` tags name. Nothing else in
 * the catalog works that way — Angular's `/src/index.html` has no `<script>` at all and
 * is correct, because `ng build` injects the bundles it lists in `angular.json`, and
 * Next, Astro, Nuxt and Remix declare no HTML entry to begin with.
 *
 * So the entry-script gate answers to the build command, not to the mere presence of an
 * `htmlEntry`. Getting this wrong is not a near-miss: it refuses every Angular demo the
 * MCP publishes, and — worse — writes a `<script src="/src/main.ts">` into stored
 * Angular documents that were always fine.
 */
export function htmlEntryLoadsModule(cfg: {
  buildCommand: string;
  htmlEntry: string | null;
}): boolean {
  return cfg.htmlEntry !== null && snapshotBuildCommand(cfg.buildCommand).trim() === "vite build";
}
