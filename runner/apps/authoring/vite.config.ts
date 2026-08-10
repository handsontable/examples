import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.resolve(dir, "../..");

// Source maps are uploaded to Sentry and then deleted from dist/, so a production
// stack trace resolves to the original .tsx without shipping the maps publicly.
// These are only set on the deploy workflow's build step; without them the plugin
// no-ops, which is what keeps PR CI and local builds unchanged.
//
// All three are required together. With a token but no org/project the plugin is
// enabled and sentry-cli has no upload target — and an upload error fails the
// build, which in the deploy workflow means prod silently stops receiving
// frontend deploys. Treat a partial setup as "off" instead.
const uploadEnabled = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);
// The Cloudflare per-deploy id is not known at build time, so the frontend
// release is the commit — matched by the VITE_SENTRY_RELEASE define below.
const RELEASE = process.env.GITHUB_SHA;

export default defineConfig({
  define: {
    "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(RELEASE ?? ""),
  },
  build: {
    // Only emitted when there is somewhere to upload them. A build without upload
    // (local, PR CI) would otherwise leave ~12 MB of .map files in dist/ that the
    // plugin's post-upload cleanup never runs to remove — and a manual
    // `wrangler deploy` would publish them.
    sourcemap: uploadEnabled,
  },
  plugins: [
    react(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !uploadEnabled,
      release: RELEASE ? { name: RELEASE } : undefined,
      sourcemaps: { filesToDeleteAfterUpload: ["dist/**/*.map"] },
    }),
  ],
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
