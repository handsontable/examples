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
    // (local, PR CI) would otherwise leave ~12 MB of .map files in dist/ that would
    // need their own cleanup — and a manual `wrangler deploy` would publish them.
    // "hidden": the map is still built and uploaded, but no
    // `//# sourceMappingURL=` comment is written — Workers Assets' SPA
    // fallback (DEV-2569) answers a stray `.map` request with
    // `200 text/html`, which would otherwise decode as JSON and fail. Maps
    // never ship in `dist/` at all — this only removes a dead pointer.
    sourcemap: uploadEnabled ? "hidden" : false,
    // ⚠ Do not give the @babel/standalone chunk a hash-free name (reverted from #249,
    // DEV-2569). The intent was sound — Workers Assets serves this app with
    // `not_found_handling: "single-page-application"`, so a deploy rotates the hashed chunk
    // out and its path answers `200 text/html`, which strands a tab that had not fetched the
    // compiler yet. But the chunk is *not* self-contained: Rollup hoists the shared CJS
    // interop helpers into the entry, so the emitted chunk opens with
    //
    //   import { c as SD, g as Nke } from "./index-<hash>.js";
    //
    // and that path is content-hashed. Measured on the deployed build: a stable
    // `compiler-babel.js` therefore pulls the *new* build's 1.3 MB entry into an old tab, and
    // that entry's top level is `createRoot(document.getElementById("root")).render(…)` plus
    // `Sentry.init`. React 18 clears the root container, so the visitor's workspace is
    // detached and silently remounted from a different build — unsaved edits gone, no card,
    // two Sentry clients. That is strictly worse than the carded failure it replaced, which
    // tells the visitor to reload (`describeRuntimeError`, and rearmCompilerLoad's docblock).
    //
    // A stable path is still the right end state; it needs the compiler built as its own
    // self-contained artifact (or the SPA fallback stopped from answering /assets/*) rather
    // than a `chunkFileNames` rename. Until then the hash is load-bearing: it is what makes a
    // rotated chunk fail loudly.
  },
  plugins: [
    react(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !uploadEnabled,
      release: RELEASE ? { name: RELEASE } : undefined,
      // No `filesToDeleteAfterUpload`: the maps must stay on disk after this
      // plugin's Sentry upload, because the deploy workflow's next step
      // uploads the SAME files to R2 (ADR §C.3) before deleting them.
      sourcemaps: {},
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
    // `/d` and `/api` are regexes, not prefix strings: a bare key matches every
    // path that *starts* with it. For `/d` that swallowed `public/docs-examples/`
    // (the docs snapshots the picker loads) and 404'd it against the worker; for
    // `/api` it swallowed the `/api-tokens` page (DEV-2583), which proxied to a
    // worker that has no such route and 500'd where production serves the SPA.
    // The production route really is `demos.handsontable.com/api/*` (see the
    // `--routes` flags in workers/api/package.json), so the bare prefix was
    // always wider here than on the deployment it stands in for. `/embed` has
    // the same shape but nothing is named as a sibling of it today.
    // The three targets below default to ":8787" but honour `API_DEV_PORT`
    // so a walkthrough needing both the API worker and this proxy can run
    // each on its own port block (COMMON.md) without a collision.
    proxy: {
      "^/api(?:/|$)": { target: `http://localhost:${process.env.API_DEV_PORT ?? "8787"}` },
      "^/d(?:/|$)": { target: `http://localhost:${process.env.API_DEV_PORT ?? "8787"}` },
      "/embed": { target: `http://localhost:${process.env.API_DEV_PORT ?? "8787"}` },
      // The o11y worker, same-origin reasoning as `/api` above (Faro posts
      // to same-origin `/telemetry/collect`, contract §6). Reads
      // `O11Y_DEV_PORT` (default 4200) so the two stay in sync.
      "^/telemetry(?:/|$)": { target: `http://localhost:${process.env.O11Y_DEV_PORT ?? "4200"}` },
    },
  },
});
