import { vitePlugin as remix } from "@remix-run/dev";
import { installGlobals } from "@remix-run/node";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

installGlobals();

export default defineConfig({
  plugins: [remix(), tsconfigPaths()],
  server: {
    allowedHosts: true,
  },
  optimizeDeps: {
    // Remix discovers these client-side imports one-by-one during the first
    // hydration; each discovery re-runs the dep optimizer, and the page ends up
    // with chunks from mixed optimizer generations — two React copies and an
    // "Invalid hook call" hydration crash. Prebundle them in the first pass.
    include: [
      "handsontable/plugins",
      "handsontable/cellTypes",
      "handsontable/themes",
      "@handsontable/react-wrapper",
    ],
  },
});
