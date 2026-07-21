import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

// Handsontable's JS themes API (`handsontable/themes`) exists only from major
// 17 — on 15/16 the subpath is missing from the package `exports` map, so any
// import of it is a compile-time module-not-found. The demo runner pins the
// installed handsontable version before starting the dev server; read it here
// and alias the themes subpaths to a local stub on majors below 17. The
// runtime version gate in DataGrid.tsx guarantees the stub is never executed.
// `handsontable/package.json` itself is not in the `exports` map, so read the
// manifest straight from node_modules (the symlink is followed by readFileSync).
const hotManifestPath = path.join(
  process.cwd(),
  "node_modules/handsontable/package.json"
);
const hotMajor = Number(
  String(JSON.parse(readFileSync(hotManifestPath, "utf8")).version).split(".")[0]
);

const themesCompatAliases: Record<string, string> =
  hotMajor >= 17
    ? {}
    : {
        "handsontable/themes": "./lib/theme/hotThemesCompat.ts",
        "handsontable/themes/static/variables/tokens/horizon":
          "./lib/theme/hotThemesCompat.ts",
      };

const nextConfig: NextConfig = {
  devIndicators: false,
  // Static export: the demo runner's share snapshotter serves the build output
  // as static files from `out/` (BUILD_CONFIG expects outputDir "out").
  output: "export",
  // The demo runner proxies `next dev` through a per-session preview subdomain;
  // without this, Next blocks its cross-origin dev resources (HMR, fonts) and
  // the page never hydrates. *.localhost is allowed by default (local dev).
  allowedDevOrigins: ["*.demos.handsontable.com"],
  turbopack: {
    resolveAlias: themesCompatAliases,
  },
  // Wrapper/core types on majors below 17 predate some of the settings this
  // starter uses (e.g. `pagination`, object-form `dateFormat`); they are
  // ignored gracefully at runtime but fail the build-time type check. Keep
  // the type check strict on modern majors only.
  typescript: {
    ignoreBuildErrors: hotMajor < 17,
  },
};

export default nextConfig;
