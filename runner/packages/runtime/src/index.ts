export type {
  FilesMap,
  Tier,
  CatalogEntry,
  CatalogIndexEntry,
  Catalog,
  StarterBucketManifest,
  StarterBucketManifestEntry,
  DemoRuntime,
  HandsontableVersionRef,
  WriteFileOptions,
} from "./types.js";

export {
  applyHandsontableCss,
  applyHandsontableVersion,
  handsontableDependencyRef,
  pinHandsontableFiles,
  validateHandsontableVersion,
  selectedReleaseMajor,
  isHandsontablePackage,
  isNextPrereleaseVersion,
  pickLatestNextVersion,
  pkgPrNewDependencyUrl,
  parsePkgPrNewFromUrl,
  DEFAULT_MAX_MAJOR,
  DEFAULT_MIN_MAJOR,
} from "./version.js";
export type { ValidationResult } from "./version.js";

export {
  deriveDocsBucketCandidate,
  resolveDocsBucket,
  planDocsBucket,
  highestReleaseBucket,
  docsBucketAbsentMessage,
  deriveStarterBucketCandidate,
  resolveStarterBucket,
} from "./docs-bucket.js";
export type {
  DocsBucketResolution,
  DocsBucketOutcome,
  StarterBucketResolution,
} from "./docs-bucket.js";

export { mintSessionId } from "./session.js";
