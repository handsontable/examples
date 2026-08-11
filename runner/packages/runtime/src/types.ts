// Core types shared by every part of the system. The editor shell binds only to
// `DemoRuntime`; whether a Sandpack in-browser bundler or a Cloudflare Sandbox
// container is behind it is an invisible implementation detail.

/** Virtual filesystem: absolute-from-root path (e.g. "/src/index.tsx") -> file contents. */
export type FilesMap = Record<string, string>;

export type Tier = 1 | 2;

/** One importable starting template, as emitted into catalog.json by pipeline/import. */
export interface CatalogEntry {
  framework: string;
  displayName: string;
  tier: Tier;
  /** Which engine renders this example: in-browser bundler or a container. */
  engine: "sandpack" | "container";
  sandpackTemplate: string | null;
  /** Classic-bundler environment string for @codesandbox/sandpack-client (Tier 1). */
  sandpackEnvironment: string | null;
  container: string | null;
  htWrappers: string[];
  entry: string;
  htmlEntry: string | null;
  devCommand: string | null;
  buildCommand: string;
  outputDir: string;
  outputGlob: string | null;
  staticExport: boolean;
  spaMode: boolean;
  port: number | null;
  installCommand: string;
  htCoreRange: string | null;
  /** Lowest Handsontable major this starter supports, or null for no floor.
   * The UI hides lower majors from the version picker and refuses to boot them
   * (e.g. the UI-library starters need the themes API introduced in core 17). */
  minCoreMajor: number | null;
  fileCount: number;
  assets: string[];
  skipped: { path: string; reason: string }[];
  files: FilesMap;
}

/**
 * A catalog.json row (DEV-2213): everything the picker, the version dropdown,
 * and BUILD_CONFIG need, without the inlined files. Full entries live per
 * bucket under public/starter-examples/ and are lazy-fetched on select.
 * `htCoreRange` is dropped too — it is per-bucket (the bucket's pinned
 * hotVersion), not a property of the framework.
 */
export type CatalogIndexEntry = Omit<
  CatalogEntry,
  "files" | "fileCount" | "assets" | "skipped" | "htCoreRange"
>;

/** The catalog.json index: bucket list + files-free starter rows. */
export interface Catalog {
  generatedFrom: string;
  buckets: string[];
  tiers: Record<string, string>;
  examples: CatalogIndexEntry[];
}

/** One row of a starter bucket's manifest.json — picker metadata only. */
export interface StarterBucketManifestEntry {
  framework: string;
  displayName: string;
  tier: Tier;
  engine: "sandpack" | "container";
  minCoreMajor: number | null;
}

/** manifest.json of one public/starter-examples/<bucket>/ directory. */
export interface StarterBucketManifest {
  bucket: string;
  /** Git ref the bucket was generated from (prod-examples/<major> or master). */
  sourceRef: string;
  generatedFrom: string;
  /** Concrete Handsontable version pinned into every artifact of the bucket. */
  hotVersion: string;
  count: number;
  examples: StarterBucketManifestEntry[];
}

/**
 * The single interface both engines implement. `mount` boots the preview and
 * returns the URL to point the iframe at; `writeFile` streams edits (on save or
 * keystroke); lifecycle callbacks drive the shell's ready/error UI.
 */
export interface DemoRuntime {
  mount(files: FilesMap): Promise<{ previewUrl: string }>;
  writeFile(path: string, contents: string): void;
  /** Remove a file from the running preview (file-tree delete/rename). */
  deleteFile?(path: string): void;
  /**
   * Re-run the current preview without re-creating the session (the row-2
   * refresh button, `72:15708`). Deliberately *not* a remount: for Tier 2 that
   * would mint a fresh container against a five-slot pool on every click.
   * A no-op before mount.
   *
   * The returned promise settles when the refresh has landed, which is what drives
   * T5's in-flight spinner. It **never rejects** and it does not report success: a
   * failed refresh settles like any other, because failure already has its own
   * channel in `onError`. What "landed" means differs by tier, because only one of
   * them gets a real completion event: Tier 2 re-navigates the iframe and settles on
   * its `load` (or a timeout, or `dispose()`), while Tier 1 settles once the compile
   * has been handed to the bundler. Either way a dead preview cannot pin a spinner on
   * screen. The union with `void` keeps the method optional for any implementation
   * that has nothing to await.
   */
  reload?(): Promise<void> | void;
  onReady(cb: () => void): void;
  onError(cb: (e: Error) => void): void;
  dispose(): void;
}

/** A resolved, validated Handsontable version reference. */
export interface HandsontableVersionRef {
  /** Either a semver string ("18.0.0") or a pkg.pr.new build ref. */
  ref: string;
  /** True when `ref` is a pkg.pr.new build id/URL rather than a published semver. */
  pkgPrNew: boolean;
}
