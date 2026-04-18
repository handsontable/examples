import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Proxy /api/* to Django so the browser sees everything on one origin.
    // This eliminates CORS preflight issues and lets Django's CSRF cookie
    // be set for localhost:5173, which the JS can then read and forward.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
