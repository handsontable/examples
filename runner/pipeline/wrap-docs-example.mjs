// pipeline/wrap-docs-example.mjs
//
// Wraps a Handsontable *documentation* example fragment (the loose source files
// that live under handsontable/docs/content/guides/**/example*.*) into a full,
// minimal, runnable project — one per framework, with the fewest files possible.
//
// This is a dependency-free Node port of `buildProjectFiles` (+ helpers) from
// handsontable/docs/public/example-tabs.js — the exact wrapper the docs site
// already uses for its "Edit on StackBlitz" button. Kept in lockstep with that
// file so a docs example runs identically in StackBlitz and in the demo runner.
//
// Adaptations vs. the browser original:
//   - ES module exporting `wrapDocsExample()`; no DOM glue.
//   - `parseDocsExampleHtml()` uses string/regex parsing (no DOMParser).
//   - JS/TS and React builders honour the source extension (a `.ts`/`.tsx`
//     example stays TypeScript instead of being written into a `.js`/`.jsx`
//     file) so the runner's bundler/type tooling resolves it correctly.
//
// Output file keys have NO leading slash (StackBlitz convention, e.g.
// "src/main.js"); the importer re-keys them to "/src/main.js" for the runner.

const CDN_CSS = (v) => `https://unpkg.com/handsontable@${v}/dist/handsontable.full.min.css`;

/** Returns the first filename in `files` that ends with `ext`, or null. */
function findFile(files, ext) {
  return Object.keys(files).find((k) => k.endsWith(ext)) || null;
}

/**
 * Splits a docs example HTML fragment into `<style>` blocks and body markup
 * using string parsing (no DOM). `<style>` elements are collected for the head;
 * `<script>` elements are dropped from the body.
 *
 * @param {string} raw
 * @returns {{ styleChunks: string[], bodyRemainder: string }}
 */
function parseDocsExampleHtml(raw) {
  let text = String(raw || '');
  if (!text.trim()) return { styleChunks: [], bodyRemainder: '' };

  const styleChunks = [];
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
    styleChunks.push(m);
    return '';
  });
  // Drop scripts from the body fragment (they don't belong in the wrapped HTML).
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  return { styleChunks, bodyRemainder: text.trim() };
}

function indentMarkupForBody(markup) {
  return markup.split('\n').map((line) => '  ' + line).join('\n');
}

/**
 * Pushes companion `<style>` blocks onto `headParts` and returns indented body
 * HTML from the example's `.html` fragment (or the default mount markup).
 */
function mergeCompanionHtml(headParts, userFiles, defaultBodyIndented) {
  const wrapperHtmlFile = findFile(userFiles, '.html');
  if (!wrapperHtmlFile || !userFiles[wrapperHtmlFile]) return defaultBodyIndented;

  const parsed = parseDocsExampleHtml(userFiles[wrapperHtmlFile]);
  for (const chunk of parsed.styleChunks) headParts.push(chunk);
  return parsed.bodyRemainder ? indentMarkupForBody(parsed.bodyRemainder) : defaultBodyIndented;
}

// ── Vanilla JS / TS project ─────────────────────────────────────────────────

function buildJsProject(hotVersion, exampleId, userFiles, extraDeps) {
  // Honour the source language: a `.ts` example stays TypeScript.
  const tsFile = findFile(userFiles, '.ts');
  const jsFile = findFile(userFiles, '.js');
  const isTs = !!tsFile && !jsFile;
  const ext = isTs ? 'ts' : 'js';
  const srcFile = isTs ? tsFile : (jsFile || 'index.js');
  const code = userFiles[srcFile] || '';

  // Pin Vite to v5 to avoid Vite 8/rolldown aggressively tree-shaking filter
  // condition registration side effects due to sideEffects:false in the
  // handsontable package.json.
  const deps = Object.assign(
    { handsontable: hotVersion, vite: '^5.4.0' },
    isTs ? { typescript: '^5.4.0' } : {},
    extraDeps,
  );

  const pkg = JSON.stringify({
    name: 'handsontable-example',
    version: '1.0.0',
    private: true,
    packageManager: 'pnpm@10.34.5',
    dependencies: deps,
    scripts: { start: 'vite', build: 'vite build' },
  }, null, 2);

  const cssFile = findFile(userFiles, '.css');

  // Entry re-exports the example code. Handsontable CSS is loaded via a CDN
  // <link> in index.html to avoid strict exports-field CSS resolution.
  const mainCode = [
    cssFile ? 'import "../styles.css";' : '',
    `import "../index.${ext}";`,
  ].filter(Boolean).join('\n');

  const indexParts = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>Handsontable Example</title>',
    `  <link rel="stylesheet" href="${CDN_CSS(hotVersion)}" />`,
    '  <style>body { padding: 1rem; font-family: sans-serif; }</style>',
  ];

  const bodyInner = mergeCompanionHtml(indexParts, userFiles, `  <div id="${exampleId}"></div>`);

  indexParts.push('</head>');
  indexParts.push('<body>');
  indexParts.push(bodyInner);
  indexParts.push(`  <script type="module" src="/src/main.${ext}"><\/script>`);
  indexParts.push('</body>');
  indexParts.push('</html>');

  const files = {
    'package.json': pkg,
    'index.html': indexParts.join('\n'),
    [`index.${ext}`]: code,
    [`src/main.${ext}`]: mainCode,
  };
  if (cssFile) files['styles.css'] = userFiles[cssFile];
  return files;
}

// ── React project ────────────────────────────────────────────────────────────

function buildReactProject(hotVersion, exampleId, userFiles, extraDeps) {
  // Honour the source language: `.tsx` stays TypeScript, `.jsx` stays JS.
  const tsxFile = findFile(userFiles, '.tsx');
  const jsxFile = findFile(userFiles, '.jsx');
  const isTs = !!tsxFile && !jsxFile;
  const ext = isTs ? 'tsx' : 'jsx';
  const srcFile = isTs ? tsxFile : (jsxFile || 'App.jsx');
  const jsxCode = userFiles[srcFile] || '';

  const cssFile = findFile(userFiles, '.css');
  const cssImportedByName =
    cssFile && new RegExp('import\\s+[\'"]\\./?' + cssFile.replace('.', '\\.') + '[\'"]').test(jsxCode);
  const cssDestName = cssImportedByName ? cssFile : 'styles.css';

  const deps = Object.assign(
    {
      handsontable: hotVersion,
      '@handsontable/react-wrapper': hotVersion,
      react: '18.x',
      'react-dom': '18.x',
      vite: '^5.4.0',
      '@vitejs/plugin-react': '^4.0.0',
    },
    extraDeps,
  );

  const pkg = JSON.stringify({
    name: 'handsontable-react-example',
    version: '1.0.0',
    private: true,
    packageManager: 'pnpm@10.34.5',
    dependencies: deps,
    scripts: { start: 'vite', build: 'vite build' },
  }, null, 2);

  const viteConfig = [
    'import { defineConfig } from "vite";',
    'import react from "@vitejs/plugin-react";',
    '',
    'export default defineConfig({ plugins: [react()] });',
  ].join('\n');

  const mainCode = [
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
    (cssFile && !cssImportedByName) ? `import "./${cssDestName}";` : null,
    'import App from "./App";',
    '',
    `const root = createRoot(document.getElementById("${exampleId}"));`,
    'root.render(React.createElement(App));',
  ].filter(Boolean).join('\n');

  const indexParts = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>Handsontable React Example</title>',
    `  <link rel="stylesheet" href="${CDN_CSS(hotVersion)}" />`,
    '  <style>body { padding: 1rem; font-family: system-ui, -apple-system, sans-serif; }</style>',
  ];

  const bodyInner = mergeCompanionHtml(indexParts, userFiles, `  <div id="${exampleId}"></div>`);

  indexParts.push('</head>');
  indexParts.push('<body>');
  indexParts.push(bodyInner);
  indexParts.push(`  <script type="module" src="/src/main.${ext}"><\/script>`);
  indexParts.push('</body>');
  indexParts.push('</html>');

  const projectFiles = {
    'package.json': pkg,
    'vite.config.js': viteConfig,
    'index.html': indexParts.join('\n'),
    [`src/main.${ext}`]: mainCode,
    [`src/App.${ext}`]: jsxCode,
  };
  if (cssFile) projectFiles['src/' + cssDestName] = userFiles[cssFile];
  return projectFiles;
}

// ── Vue 3 project ─────────────────────────────────────────────────────────────

function buildVueProject(hotVersion, exampleId, userFiles, extraDeps) {
  const vueFile = findFile(userFiles, '.vue') || 'App.vue';
  const appCode = userFiles[vueFile] || '';

  const cssFile = findFile(userFiles, '.css');
  const cssImportedByName =
    cssFile && new RegExp('import\\s+[\'"]\\./?' + cssFile.replace('.', '\\.') + '[\'"]').test(appCode);
  const cssDestName = cssImportedByName ? cssFile : 'styles.css';

  const deps = Object.assign(
    {
      handsontable: hotVersion,
      '@handsontable/vue3': hotVersion,
      vue: '3.x',
      vite: '^5.4.0',
      '@vitejs/plugin-vue': '^5.0.0',
    },
    extraDeps,
  );

  const pkg = JSON.stringify({
    name: 'handsontable-vue-example',
    version: '1.0.0',
    private: true,
    packageManager: 'pnpm@10.34.5',
    dependencies: deps,
    scripts: { start: 'vite', build: 'vite build' },
  }, null, 2);

  const viteConfig = [
    'import { defineConfig } from "vite";',
    'import vue from "@vitejs/plugin-vue";',
    '',
    'export default defineConfig({ plugins: [vue()] });',
  ].join('\n');

  const mainCode = [
    'import { createApp } from "vue";',
    (cssFile && !cssImportedByName) ? `import "./${cssDestName}";` : null,
    'import App from "./App.vue";',
    '',
    `createApp(App).mount("#${exampleId}");`,
  ].filter(Boolean).join('\n');

  const indexParts = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>Handsontable Vue Example</title>',
    `  <link rel="stylesheet" href="${CDN_CSS(hotVersion)}" />`,
  ];

  const bodyInner = mergeCompanionHtml(indexParts, userFiles, `  <div id="${exampleId}"></div>`);

  indexParts.push('</head>');
  indexParts.push('<body>');
  indexParts.push(bodyInner);
  // Entry is main.ts (not .js): the in-browser Vue bundler treats a `.js` entry
  // as a non-module script ("Cannot use import statement outside a module").
  indexParts.push('  <script type="module" src="/src/main.ts"><\/script>');
  indexParts.push('</body>');
  indexParts.push('</html>');

  const projectFiles = {
    'package.json': pkg,
    'vite.config.js': viteConfig,
    'index.html': indexParts.join('\n'),
    'src/main.ts': mainCode,
    'src/App.vue': appCode,
  };
  if (cssFile) projectFiles['src/' + cssDestName] = userFiles[cssFile];
  return projectFiles;
}

// ── Angular project ────────────────────────────────────────────────────────────

/**
 * Splits a multi-section Angular source file into individual files. Sections are
 * delimited by `/* file: filename *\/ ... /* end-file *\/`; content inside
 * `/* start:skip-in-compilation *\/ … /* end:skip-in-compilation *\/` is stripped.
 */
function parseAngularSourceFiles(raw) {
  const files = {};
  const fileRe = /\/\* file: ([^*]+?) \*\/([\s\S]*?)\/\* end-file \*\//g;
  const skipRe = /\/\* start:skip-in-compilation \*\/[\s\S]*?\/\* end:skip-in-compilation \*\//g;
  let match;
  while ((match = fileRe.exec(raw)) !== null) {
    files[match[1].trim()] = match[2].replace(skipRe, '').trim();
  }
  if (!Object.keys(files).length) files['app.component.ts'] = raw.trim();
  return files;
}

/** Extracts the @Component selector value (the LAST one), defaulting to 'app-root'. */
function extractAngularSelector(tsCode) {
  const matches = tsCode.match(/selector\s*:\s*['"]([^'"]+)['"]/g);
  if (!matches || !matches.length) return 'app-root';
  const last = matches[matches.length - 1].match(/selector\s*:\s*['"]([^'"]+)['"]/);
  return last ? last[1] : 'app-root';
}

function buildAngularProject(hotVersion, exampleId, userFiles, extraDeps, extraDevDeps) {
  const tsFile = findFile(userFiles, '.ts') || 'app.component.ts';
  const tsCode = userFiles[tsFile] || '';
  const cssFile = findFile(userFiles, '.css');

  const parsed = parseAngularSourceFiles(tsCode);
  const componentCode = parsed['app.component.ts'] || tsCode;
  let moduleCode = parsed['app.module.ts'] || null;
  const configCode = parsed['app.config.ts'] || null;

  const selector = extractAngularSelector(componentCode);

  // Re-inject the component import into app.module.ts (stripped with skip markers).
  if (moduleCode) {
    const classNameMatch = componentCode.match(/export\s+class\s+(\w+)/);
    const compClassName = classNameMatch ? classNameMatch[1] : null;
    if (compClassName) {
      moduleCode = "import { " + compClassName + " } from './app.component';\n" + moduleCode;
    }
  }

  const deps = Object.assign(
    {
      handsontable: hotVersion,
      '@handsontable/angular-wrapper': hotVersion,
      '@angular/animations': '21.x',
      '@angular/common': '21.x',
      '@angular/compiler': '21.x',
      '@angular/core': '21.x',
      '@angular/forms': '21.x',
      '@angular/platform-browser': '21.x',
      '@angular/platform-browser-dynamic': '21.x',
      '@angular/router': '21.x',
      rxjs: '~7.8.0',
      tslib: '^2.3.0',
      'zone.js': '~0.15.0',
      '@angular-devkit/build-angular': '21.x',
      '@angular/cli': '21.x',
      '@angular/compiler-cli': '21.x',
      typescript: '~5.9.0',
    },
    extraDeps,
  );

  const pkg = JSON.stringify({
    name: 'handsontable-angular-example',
    version: '1.0.0',
    private: true,
    packageManager: 'pnpm@10.34.5',
    scripts: { ng: 'ng', start: 'ng serve', build: 'ng build' },
    dependencies: deps,
    devDependencies: Object.assign(
      {},
      extraDeps['papaparse'] ? { '@types/papaparse': extraDevDeps['@types/papaparse'] } : {},
      extraDeps['moment'] ? { '@types/moment': extraDevDeps['@types/moment'] } : {},
      // Upstream `pikaday` ships no typings (the `@handsontable/pikaday` fork
      // did) — without the stub `ng serve` fails on TS7016. DEV-2182.
      extraDeps['pikaday'] ? { '@types/pikaday': extraDevDeps['@types/pikaday'] } : {},
    ),
  }, null, 2);

  const angularJson = JSON.stringify({
    $schema: './node_modules/@angular/cli/lib/config/schema.json',
    version: 1,
    newProjectRoot: 'projects',
    projects: {
      app: {
        projectType: 'application',
        root: '',
        sourceRoot: 'src',
        prefix: 'app',
        architect: {
          build: {
            builder: '@angular-devkit/build-angular:application',
            options: {
              outputPath: 'dist/app',
              index: 'src/index.html',
              browser: 'src/main.ts',
              polyfills: ['zone.js'],
              tsConfig: 'tsconfig.json',
              assets: [],
              styles: cssFile ? ['src/styles.css'] : [],
              scripts: [],
            },
            configurations: { development: { optimization: false, sourceMap: true } },
            defaultConfiguration: 'development',
          },
          serve: {
            builder: '@angular-devkit/build-angular:dev-server',
            configurations: { development: { buildTarget: 'app:build:development' } },
            defaultConfiguration: 'development',
          },
        },
      },
    },
  }, null, 2);

  const tsConfig = JSON.stringify({
    compilerOptions: {
      outDir: './dist/out-tsc',
      strict: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      skipLibCheck: true,
      esModuleInterop: true,
      sourceMap: true,
      declaration: false,
      experimentalDecorators: true,
      moduleResolution: 'bundler',
      importHelpers: true,
      target: 'ES2022',
      module: 'ES2022',
      useDefineForClassFields: false,
      lib: ['ES2022', 'dom'],
    },
    angularCompilerOptions: {
      enableI18nLegacyMessageIdFormat: false,
      strictInjectionParameters: true,
      strictInputAccessModifiers: true,
      strictTemplates: true,
    },
  }, null, 2);

  const indexParts = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>Handsontable Angular Example</title>',
    '  <base href="/">',
    `  <link rel="stylesheet" href="${CDN_CSS(hotVersion)}" />`,
    '  <style>body { padding: 1rem; font-family: system-ui, -apple-system, sans-serif; }</style>',
  ];

  const bodyMarkup = mergeCompanionHtml(indexParts, userFiles, '  <' + selector + '></' + selector + '>');

  indexParts.push('</head>');
  indexParts.push('<body>');
  indexParts.push(bodyMarkup);
  indexParts.push('</body>');
  indexParts.push('</html>');

  let mainTs;
  if (moduleCode) {
    mainTs = [
      "import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';",
      "import { AppModule } from './app/app.module';",
      '',
      'platformBrowserDynamic().bootstrapModule(AppModule)',
      '  .catch(err => console.error(err));',
    ].join('\n');
  } else {
    const classMatch =
      componentCode.match(/export\s+class\s+(AppComponent\b)/) ||
      componentCode.match(/export\s+class\s+(\w+)/);
    const className = classMatch ? classMatch[1] : 'AppComponent';
    if (configCode) {
      mainTs = [
        "import { bootstrapApplication } from '@angular/platform-browser';",
        "import { registerAllModules } from 'handsontable/registry';",
        "import { " + className + " } from './app/app.component';",
        "import { appConfig } from './app/app.config';",
        '',
        'registerAllModules();',
        '',
        'bootstrapApplication(' + className + ', appConfig).catch(err => console.error(err));',
      ].join('\n');
    } else {
      mainTs = [
        "import { bootstrapApplication } from '@angular/platform-browser';",
        "import { registerAllModules } from 'handsontable/registry';",
        "import { " + className + " } from './app/app.component';",
        '',
        'registerAllModules();',
        '',
        'bootstrapApplication(' + className + ').catch(err => console.error(err));',
      ].join('\n');
    }
  }

  const files = {
    'package.json': pkg,
    'angular.json': angularJson,
    'tsconfig.json': tsConfig,
    'src/index.html': indexParts.join('\n'),
    'src/main.ts': mainTs,
    'src/app/app.component.ts': componentCode,
  };
  if (moduleCode) files['src/app/app.module.ts'] = moduleCode;
  if (configCode) files['src/app/app.config.ts'] = configCode;
  if (cssFile) files['src/styles.css'] = userFiles[cssFile];
  return files;
}

/**
 * Wrap a docs example fragment into a full, minimal, runnable project.
 *
 * @param {object} opts
 * @param {'javascript'|'react'|'vue'|'angular'} opts.framework
 * @param {string} opts.hotVersion   Handsontable version to pin (e.g. "18.0.0").
 * @param {string} opts.exampleId    Mount id, e.g. "example1".
 * @param {Record<string,string>} opts.userFiles  Fragment files keyed by basename.
 * @param {Record<string,string>} [opts.extraDeps] Extra npm deps discovered from imports.
 * @param {Record<string,string>} [opts.extraDevDeps] Extra npm development deps.
 * @returns {Record<string,string>} Full project files (keys have no leading slash).
 */
export function wrapDocsExample({
  framework,
  hotVersion,
  exampleId,
  userFiles,
  extraDeps = {},
  extraDevDeps = {},
}) {
  const v = hotVersion || 'latest';
  const id = exampleId || 'example';
  if (framework === 'react') return buildReactProject(v, id, userFiles, extraDeps);
  if (framework === 'vue') return buildVueProject(v, id, userFiles, extraDeps);
  if (framework === 'angular') return buildAngularProject(v, id, userFiles, extraDeps, extraDevDeps);
  return buildJsProject(v, id, userFiles, extraDeps);
}
