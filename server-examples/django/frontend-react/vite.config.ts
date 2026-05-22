import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/react-assets/',
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: 'react.html',
    },
  },
});
