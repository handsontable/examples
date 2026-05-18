import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    allowedHosts: true,
    proxy: {
      '/tickets': 'http://localhost:3000',
    },
  },
});
