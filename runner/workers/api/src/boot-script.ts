// The Tier-2 session boot script (the `sh -lc` body `index.ts` starts in the
// container). Free of Cloudflare imports so `pipeline/` can exercise it directly.

export interface BootScriptInput {
  root: string;
  bakedKey: string;
  /** The frozen/non-frozen pnpm reconciliation lines. */
  installLines: string[];
  devCmd: string;
  /** The submitted starter's dependency metadata is the baked context's own. */
  pristine: boolean;
}

export function bootScript({ root, bakedKey, installLines, devCmd, pristine }: BootScriptInput): string {
  return [
    `set -e`,
    `cd ${root}`,
    `echo '::seeding immutable baked dependencies::'`,
    `rm -rf ./node_modules`,
    `cp -al /baked/${bakedKey}/node_modules ./node_modules`,
    // A context may carry a dev cache primed at image build (`prime-dev-cache.sh`),
    // so the first request does not pay the cold compile. Custom dependency
    // metadata means the cache was built against other modules, so skip it.
    ...(pristine
      ? [`if [ -d /baked/${bakedKey}/.next ]; then cp -a /baked/${bakedKey}/.next ./.next; fi`]
      : []),
    `echo '::reconciling dependencies with pnpm::'`,
    ...installLines,
    `echo '::starting dev server::'`,
    devCmd,
  ].join("\n");
}
