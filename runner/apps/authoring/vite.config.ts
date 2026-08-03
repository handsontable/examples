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
    // Production serves the SPA and the API worker from one origin
    // (demos.handsontable.com); locally they are two. `serveDemoAsset` sends
    // `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` for `/d/:id` and
    // is not wrapped in `cors()`, so a cross-origin dev setup makes `?mode=full`
    // unusable: the browser refuses the iframe ("refused to connect") and the
    // status probe fails CORS (`● error`). Proxying the worker's routes through
    // this server reproduces the production single origin.
    //
    // `changeOrigin` stays off on purpose: the `/d/:id` -> `/d/:id/` 308 is built
    // from the incoming Host header, so rewriting it would bounce the iframe back
    // to :8787 and re-trigger the framing block.
    //
    // Set `VITE_API_BASE=http://localhost:5173` to route through this. An empty
    // value does not work — `App.tsx` falls back to :8787 on any falsy value.
    // `/d` is a regex, not a prefix string: a bare "/d" key matches every path
    // that *starts* with it, which swallows `public/docs-examples/` (the docs
    // snapshots the picker loads) and 404s it against the worker.
    proxy: {
      "/api": { target: "http://localhost:8787" },
      "^/d(?:/|$)": { target: "http://localhost:8787" },
      "/embed": { target: "http://localhost:8787" },
    },
  },
});
