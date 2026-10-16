// The Tier-2 session boot script (the `sh -lc` body `index.ts` starts in the
// container). Free of Cloudflare imports so `pipeline/` can exercise it directly.

export interface BootScriptInput {
  root: string;
  bakedKey: string;
  /** The frozen/non-frozen pnpm reconciliation lines. */
  installLines: string[];
  devCmd: string;
  /** The cache was primed for exactly this starter: its dependency metadata is the baked context's own. */
  restoreDevCache: boolean;
}

/**
 * Every bucket's starter maps to one baked context, built from the seed
 * bucket's starter (its key ends in that bucket). Only a session on that
 * bucket's own starter matches the modules the dev cache was compiled against.
 */
export function matchesPrimedContext(bakedKey: string, context: { bucket: string } | undefined): boolean {
  return context !== undefined && bakedKey.endsWith(`-${context.bucket}`);
}

export function bootScript({ root, bakedKey, installLines, devCmd, restoreDevCache }: BootScriptInput): string {
  return [
    `set -e`,
    `cd ${root}`,
    `echo '::seeding immutable baked dependencies::'`,
    `rm -rf ./node_modules`,
    `cp -al /baked/${bakedKey}/node_modules ./node_modules`,
    // A context may carry a dev cache primed at image build (`prime-dev-cache.sh`),
    // so the first request does not pay the cold compile.
    ...(restoreDevCache
      ? [
          `if [ -d /baked/${bakedKey}/.next ]; then rm -rf ./.next && mkdir ./.next && cp -a /baked/${bakedKey}/.next/. ./.next/; fi`,
        ]
      : []),
    `echo '::reconciling dependencies with pnpm::'`,
    ...installLines,
    `echo '::starting dev server::'`,
    devCmd,
  ].join("\n");
}
