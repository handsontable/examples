import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true, // CodeSandbox preview hosts (*.csb.app)
  },
  optimizeDeps: {
    include: ['handsontable', '@handsontable/react-wrapper', '@mui/material', '@emotion/react', '@emotion/styled'],
  },
});
