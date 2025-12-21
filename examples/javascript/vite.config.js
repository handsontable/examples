import { defineConfig } from "vite";
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  base: "./",
  plugins: [
    visualizer({ filename: 'dist/stats.html', open: false })
  ],
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/node_modules/handsontable')) return 'vendor-handsontable';
            if (id.includes('/node_modules/hyperformula')) return 'vendor-hyperformula';
            if (id.includes('/node_modules/core-js')) return 'vendor-polyfills';
            if (id.match(/node_modules\/(react|react-dom|lodash|date-fns)\b/)) {
              return 'vendor-core';
            }
            return 'vendor';
          }
        }
      }
    }
  }
});
