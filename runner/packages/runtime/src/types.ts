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

export interface Catalog {
  generatedFrom: string;
  supportedHandsontableMajors: number[];
  tiers: Record<string, string>;
  examples: CatalogEntry[];
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
   */
  reload?(): void;
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
