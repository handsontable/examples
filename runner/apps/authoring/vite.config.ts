import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const runnerRoot = path.resolve(dir, "../..");

// Source maps are uploaded to Sentry and then deleted from dist/, so a production
// stack trace resolves to the original .tsx without shipping the maps publicly.
// The token is only present on the deploy workflow's build step: without it the
// plugin no-ops, which is what keeps PR CI and local builds unchanged.
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
// The Cloudflare per-deploy id is not known at build time, so the frontend
// release is the commit — matched by the VITE_SENTRY_RELEASE define below.
const RELEASE = process.env.GITHUB_SHA;

export default defineConfig({
  define: {
    "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(RELEASE ?? ""),
  },
  build: {
    // Only emitted when there is a token to upload them with. A build without one
    // (local, PR CI) would otherwise leave ~12 MB of .map files in dist/ that the
    // plugin's post-upload cleanup never runs to remove — and a manual
    // `wrangler deploy` would publish them.
    sourcemap: Boolean(SENTRY_AUTH_TOKEN),
  },
  plugins: [
    react(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: SENTRY_AUTH_TOKEN,
      disable: !SENTRY_AUTH_TOKEN,
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
  },
});
