import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Static export: the demo runner's share snapshotter serves the build output
  // as static files from `out/` (BUILD_CONFIG expects outputDir "out").
  output: "export",
  // The demo runner proxies `next dev` through a per-session preview subdomain;
  // without this, Next blocks its cross-origin dev resources (HMR, fonts) and
  // the page never hydrates. *.localhost is allowed by default (local dev).
  allowedDevOrigins: ["*.demos.handsontable.com"],
};

export default nextConfig;
