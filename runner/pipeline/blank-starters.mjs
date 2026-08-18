// pipeline/blank-starters.mjs — the BLANK starter templates (DEV-2499).
//
// "New demo" used to mean forking a catalog example, so every fresh demo opened
// with sample data, two helper modules, ten registered plugins and four cell
// types to delete first. These templates are the bare minimum that renders a
// grid: one entry file, one HTML host, one package.json.
//
// They are SYNTHESIZED here rather than committed as folders under `examples/`
// for two reasons:
//
//  1. The emitted code has to differ per bucket (see `isLegacyBucket`), so a
//     disk-backed variant would have to be hand-committed to `prod-examples/15`
//     and `prod-examples/16` and kept in sync with this one forever.
//  2. `examples/` is the published example set. A blank grid is a runner
//     affordance, not an example anyone should land on from the website.
//
// Consumed by pipeline/import.mjs for every framework flagged `synthetic` in
// config/frameworks.json.

/** Framework keys this module can generate; mirrors the `synthetic` flags. */
export const BLANK_FRAMEWORKS = ["blank", "blank-ts", "blank-react"];

const LICENSE_KEY = "non-commercial-and-evaluation";

// Pinned for the same reason every real starter pins it: the importer resolves
// the pnpm lockfile through corepack, and the Tier-2 image bakes pnpm 10.34.5.
// Without this field corepack picks its own latest (pnpm 11 today), whose
// lockfile format the image's pnpm rejects — the frozen install then fails and
// the builder silently falls back to a fresh resolve.
const PACKAGE_MANAGER = "pnpm@10.34.5";

// Toolchain pins, matched to what the real starters already resolve so a blank
// demo installs from the same warm registry surface.
const VITE = "^8.1.1";
const TYPESCRIPT = "~6.0.3";
const REACT = "^19.2.7";
const REACT_DOM = "^19.2.6";
const TYPES_REACT = "^19.2.17";
const TYPES_REACT_DOM = "^19.2.3";
const PLUGIN_REACT = "^6.0.3";

// Placeholder ranges: pipeline/import.mjs `pinHandsontableDependencies` rewrites
// every dependency whose name contains "handsontable" to the bucket's concrete
// version, so nothing here should try to guess it.
const HOT_PLACEHOLDER = "latest";

/**
 * Does this bucket predate the 17.0.0 styling contract? (DEV-2200)
 *
 * 17.0.0 auto-injects core CSS and ships the JS theme object, so 17+/next
 * templates import neither stylesheet and pass `theme: mainTheme`. Below 17
 * there is no auto-injection and no `handsontable/themes` subpath at all, so
 * those templates import both stylesheets and name the theme as the `themeName`
 * STRING instead.
 *
 * Getting this backwards is invisible in review and fatal at runtime: on 17+ a
 * string `themeName` names a stylesheet nothing injects (unstyled grid), and
 * below 17 `handsontable/themes` does not resolve (bundler error).
 *
 * Keyed off the bucket rather than the pinned version on purpose — the "next"
 * bucket pins `0.0.0-next-<sha>-<date>`, whose major parses as 0.
 */
function isLegacyBucket(bucket) {
  return bucket !== "next" && Number(bucket) < 17;
}

/** The one grid configuration every template shares: an empty 5×5 sheet. */
const GRID_OPTIONS = [
  "startRows: 5",
  "startCols: 5",
  "rowHeaders: true",
  "colHeaders: true",
];

function packageJson(fields) {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

/** The two pre-17 stylesheet imports, as their own paragraph. */
const LEGACY_STYLE_IMPORTS = [
  "",
  "import 'handsontable/styles/handsontable.min.css';",
  "import 'handsontable/styles/ht-theme-main.min.css';",
];

/** Vanilla JS/TS: `/index.js` or `/index.ts`. */
function vanillaEntry(bucket, { typescript }) {
  const legacy = isLegacyBucket(bucket);
  const lines = ["import Handsontable from 'handsontable';"];
  if (legacy) lines.push(...LEGACY_STYLE_IMPORTS);
  else lines.push("import { mainTheme } from 'handsontable/themes';");
  lines.push(
    "",
    "// The full bundle: every plugin and cell type is available to switch on in",
    "// the settings below — none are enabled here.",
    // TS needs the non-null assertion; getElementById is `HTMLElement | null`.
    `const container = document.getElementById('example')${typescript ? "!" : ""};`,
    "",
    "new Handsontable(container, {",
    ...GRID_OPTIONS.map((o) => `  ${o},`),
    legacy ? "  themeName: 'ht-theme-main'," : "  theme: { ...mainTheme, colorScheme: 'light' },",
    `  licenseKey: '${LICENSE_KEY}',`,
    "});",
    "",
  );
  return lines.join("\n");
}

/** React: `/src/index.tsx`. */
function reactEntry(bucket) {
  const legacy = isLegacyBucket(bucket);
  const lines = [
    // `import React` is not vestigial: Tier-1 mounts this through Sandpack's
    // classic `create-react-app-typescript` environment, whose JSX transform
    // uses the classic runtime and needs `React` in scope.
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { HotTable } from '@handsontable/react-wrapper';",
  ];
  if (legacy) lines.push(...LEGACY_STYLE_IMPORTS);
  else lines.push("import { mainTheme } from 'handsontable/themes';");
  lines.push(
    "",
    "createRoot(document.getElementById('root')!).render(",
    "  <HotTable",
    ...GRID_OPTIONS.map((o) => {
      const [key, value] = o.split(": ");
      return `    ${key}={${value}}`;
    }),
    legacy ? '    themeName="ht-theme-main"' : "    theme={{ ...mainTheme, colorScheme: 'light' }}",
    `    licenseKey="${LICENSE_KEY}"`,
    "  />,",
    ");",
    "",
  );
  return lines.join("\n");
}

function html({ title, mount, script }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="${mount}"></div>
    <script type="module" src="${script}"></script>
  </body>
</html>
`;
}

/**
 * Minimal tsconfig for the TS templates. It has no effect on the preview
 * (Sandpack transpiles, and the snapshot build runs `vite build`, which strips
 * types without reading this file) — it is here so a downloaded .zip opens in an
 * editor with working types instead of red squiggles.
 */
function tsconfig({ jsx }) {
  return packageJson({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      ...(jsx ? { jsx: "react-jsx" } : {}),
    },
  });
}

const BLANK = {
  blank: (bucket) => ({
    "/index.html": html({
      title: "Handsontable — blank",
      mount: "example",
      script: "./index.js",
    }),
    "/index.js": vanillaEntry(bucket, { typescript: false }),
    "/package.json": packageJson({
      name: "handsontable-blank",
      private: true,
      version: "0.0.0",
      packageManager: PACKAGE_MANAGER,
      type: "module",
      scripts: { dev: "vite --port 8080", build: "vite build", preview: "vite preview" },
      dependencies: { handsontable: HOT_PLACEHOLDER },
      devDependencies: { vite: VITE },
    }),
  }),

  "blank-ts": (bucket) => ({
    "/index.html": html({
      title: "Handsontable — blank (TypeScript)",
      mount: "example",
      script: "./index.ts",
    }),
    "/index.ts": vanillaEntry(bucket, { typescript: true }),
    "/package.json": packageJson({
      name: "handsontable-blank-typescript",
      private: true,
      version: "0.0.0",
      packageManager: PACKAGE_MANAGER,
      type: "module",
      scripts: { dev: "vite --port 8080", build: "vite build", preview: "vite preview" },
      dependencies: { handsontable: HOT_PLACEHOLDER },
      devDependencies: { typescript: TYPESCRIPT, vite: VITE },
    }),
    "/tsconfig.json": tsconfig({ jsx: false }),
  }),

  "blank-react": (bucket) => ({
    "/index.html": html({
      title: "Handsontable — blank (React)",
      mount: "root",
      script: "/src/index.tsx",
    }),
    "/src/index.tsx": reactEntry(bucket),
    "/package.json": packageJson({
      name: "handsontable-blank-react",
      private: true,
      version: "0.0.0",
      packageManager: PACKAGE_MANAGER,
      type: "module",
      scripts: { dev: "vite --port 8080", build: "vite build", preview: "vite preview" },
      dependencies: {
        "@handsontable/react-wrapper": HOT_PLACEHOLDER,
        handsontable: HOT_PLACEHOLDER,
        react: REACT,
        "react-dom": REACT_DOM,
      },
      devDependencies: {
        "@types/react": TYPES_REACT,
        "@types/react-dom": TYPES_REACT_DOM,
        "@vitejs/plugin-react": PLUGIN_REACT,
        typescript: TYPESCRIPT,
        vite: VITE,
      },
    }),
    "/tsconfig.json": tsconfig({ jsx: true }),
    // The only config file in any blank template, and it earns its place: `vite
    // build` cannot compile JSX without the React plugin, so the snapshot build
    // fails without this.
    "/vite.config.ts": `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
});
`,
  }),
};

/**
 * The files for one blank template in one bucket. Throws on an unknown
 * framework: `importStarters` reaches here only for `synthetic` config entries,
 * so a mismatch between the two lists is a generation bug, not a user error.
 */
export function blankStarterFiles(framework, { bucket }) {
  const make = BLANK[framework];
  if (!make) {
    throw new Error(
      `no blank template for synthetic framework ${JSON.stringify(framework)}; ` +
        `known: ${BLANK_FRAMEWORKS.join(", ")}`,
    );
  }
  return make(bucket);
}
