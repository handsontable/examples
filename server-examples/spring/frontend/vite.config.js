import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Forward all /api/* requests to the Spring Boot backend.
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
