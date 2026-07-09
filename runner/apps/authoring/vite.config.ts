import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.resolve(dir, "../..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Compile the editor shell as first-party TSX (it ships TS source).
      "@handsontable/demo-editor-shell": path.resolve(
        runnerRoot,
        "packages/editor-shell/src/index.ts",
      ),
    },
  },
  server: {
    fs: {
      // Allow importing catalog.json and workspace package sources.
      allow: [runnerRoot],
    },
  },
});
