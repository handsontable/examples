import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  devToolbar: {
    // The toolbar's own client entrypoint (@id/astro/runtime/client/dev-toolbar/entrypoint.js)
    // intermittently 504s through the Tier-2 preview proxy; the toolbar has no use in an
    // embedded preview iframe anyway.
    enabled: false,
  },
  vite: {
    server: {
      allowedHosts: true, // allow Handsontable Tier-2 preview hosts (*.demos.handsontable.com)
    },
  },
});
