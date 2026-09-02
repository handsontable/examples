// The one place that knows what the snapshot builder actually runs. A leaf on
// purpose: both `share.ts` (which runs it) and `mcp-create.ts` (which asks what
// binary it will invoke) import it, and `mcp-create.ts` must stay import-free of
// the Worker's heavy modules (see its own header comment).

/** The build command as the snapshot builder runs it: the leading type-check step is
 *  stripped, because snapshots need the bundle, not type-checking. */
export function snapshotBuildCommand(buildCommand: string): string {
  return buildCommand.replace(/^\s*(tsc(\s+-b)?|vue-tsc[^&]*)\s*&&\s*/i, "");
}
