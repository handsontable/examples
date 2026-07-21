import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Handsontable's JS themes API (`handsontable/themes`) exists only from major
// 17 — on 15/16 the subpath is missing from the package `exports` map, so any
// import of it fails resolution. The demo runner pins the installed
// handsontable version before starting the dev server; read it here and alias
// the themes subpaths to a local stub on majors below 17. The runtime version
// gate in src/theme/hotTheme.ts guarantees the stub is never executed.
const hotManifest = JSON.parse(
  readFileSync(path.join(__dirname, 'node_modules/handsontable/package.json'), 'utf8')
);
const hotMajor = Number(String(hotManifest.version).split('.')[0]);

const themesCompatAliases =
  hotMajor >= 17
    ? []
    : [
        {
          find: /^handsontable\/themes(\/.*)?$/,
          replacement: path.resolve(__dirname, 'src/theme/hotThemesCompat.ts'),
        },
      ];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: themesCompatAliases,
  },
  server: {
    allowedHosts: true, // CodeSandbox preview hosts (*.csb.app)
  },
  optimizeDeps: {
    include: ['handsontable', '@handsontable/react-wrapper', '@fluentui/react-components'],
  },
});
