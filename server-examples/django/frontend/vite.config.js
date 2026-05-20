import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const angularDist = path.resolve(__dirname, '../frontend-angular/dist');
const reactDist = path.resolve(__dirname, '../frontend-react/dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.map':  'application/json',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.woff2': 'font/woff2',
};

// Serves Angular's pre-built output through Vite's dev server.
// Angular puts ALL browser files (including angular.html) in dist/browser/:
//   GET /angular.html      → frontend-angular/dist/browser/angular.html
//   GET /angular-assets/*  → frontend-angular/dist/browser/*
const angularPlugin = {
  name: 'serve-angular',
  enforce: 'pre',
  configureServer(server) {
    server.middlewares.use('/angular.html', (_req, res) => {
      const file = path.join(angularDist, 'browser', 'angular.html');
      if (fs.existsSync(file)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(file));
      } else {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<p>Angular app not built yet. Run: <code>cd frontend-angular && npm run build</code></p>');
      }
    });

    server.middlewares.use('/angular-assets', (req, res, next) => {
      const file = path.join(angularDist, 'browser', req.url.split('?')[0]);
      if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
        const ext = path.extname(file);
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(file));
      } else {
        next();
      }
    });
  },
};

// Serves React's pre-built Vite output through the dev server.
// Vite (with base '/react-assets/') puts react.html at dist/react.html
// and assets at dist/assets/*. The browser requests them as /react-assets/assets/*.
const reactPlugin = {
  name: 'serve-react',
  enforce: 'pre',
  configureServer(server) {
    server.middlewares.use('/react.html', (_req, res) => {
      const file = path.join(reactDist, 'react.html');
      if (fs.existsSync(file)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(file));
      } else {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<p>React app not built yet. Run: <code>cd frontend-react && npm run build</code></p>');
      }
    });

    // req.url has the /react-assets prefix stripped by connect, so
    // /react-assets/assets/index.js → req.url = /assets/index.js → dist/assets/index.js
    server.middlewares.use('/react-assets', (req, res, next) => {
      const file = path.join(reactDist, req.url.split('?')[0]);
      if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
        const ext = path.extname(file);
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(file));
      } else {
        next();
      }
    });
  },
};

export default defineConfig({
  plugins: [angularPlugin, reactPlugin],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
