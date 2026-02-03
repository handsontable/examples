import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  vite: {
    server: {
      allowedHosts: true, // allow CodeSandbox preview hosts (*.csb.app)
    },
  },
});
