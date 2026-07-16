import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Static export: the demo runner's share snapshotter serves the build output
  // as static files from `out/` (BUILD_CONFIG expects outputDir "out").
  output: "export",
};

export default nextConfig;
