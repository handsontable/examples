// Regenerate the seti-ui file-type icon tables in
// packages/editor-shell/src/icons/generated/seti.ts (DEV-2155 / ADR-0024).
//
// Reads three things from jesseweed/seti-ui at a pinned commit:
//   styles/components/icons/mapping.less  extension/filename -> icon name + @colour
//   styles/ui-variables.less              @colour -> hex
//   icons/<name>.svg                      32x32 geometry (its baked `fill` is dropped)
//
// The mapping is the colour source of truth, not the SVG's baked fill — the two
// disagree upstream (typescript.svg bakes #529BBA, @blue is #519aba) and the
// mapping is what seti's own editor uses. Emitted paths render with
// `fill="currentColor"` so one code path covers hover/selected/fallback.
//
// Coverage is curated: only file types the runner can actually contain. See
// CURATED_* below. Everything else resolves to the `default` icon at runtime.
//
// Usage: node scripts/sync-seti-icons.mjs
//        Commit the generated file; CI installs --frozen-lockfile and never
//        runs this script.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "..");
const OUT_FILE = path.join(
  RUNNER_DIR,
  "packages/editor-shell/src/icons/generated/seti.ts",
);

// Pinned so regeneration is reproducible. Bump deliberately, re-run, review the diff.
const SETI_REPO = "jesseweed/seti-ui";
const SETI_SHA = "2d6c5e68b4ded73c92dac291845ee44e1182d511"; // 2025-10-28
const RAW = `https://raw.githubusercontent.com/${SETI_REPO}/${SETI_SHA}`;

// Suffixes, longest-first at resolve time, so ".test.ts" wins over ".ts".
// Every entry here must resolve against mapping.less or the script fails —
// that's the point: upstream dropping one should not silently degrade to
// `default`. Deliberately absent because upstream has no entry: `.astro`,
// `.lock`, `.mts`, `.cts`, `.d.ts`, `.component.ts`, `package.json`,
// `pnpm-lock.yaml`, `angular.json`. Those fall through to the plain extension
// (so package.json gets the json icon, pnpm-lock.yaml the yml icon) or to
// `default`. Also absent: `.zip`/`.pdf`/`.mp4`, whose upstream icons are
// two-colour (a white `<g>` over a coloured body) and cannot survive flattening
// to `currentColor` — no runner demo contains those file types anyway.
const CURATED_SUFFIXES = [
  ".test.ts", ".spec.ts",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".html", ".css", ".scss", ".less",
  ".json", ".md", ".txt", ".yml", ".yaml", ".toml", ".env", ".csv", ".sh",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".woff", ".woff2", ".ttf",
  // Dotfiles land here too — the resolver walks suffixes of the basename, so
  // ".gitignore" matches the whole name of a file called `.gitignore`.
  ".gitignore", ".gitattributes", ".npmrc", ".editorconfig", ".eslintrc",
];

const CURATED_NAMES = [
  "tsconfig.json", "vite.config.ts", "vite.config.js", "yarn.lock",
  "README.md", "LICENSE",
];

// Rendered by <FolderIcon />. mapping.less has no entry for it, so its colour
// comes from the SVG's own fill — the one place the baked fill is used.
const FOLDER_ICON = "folder";
const FALLBACK_ICON = "default";

async function fetchText(rel) {
  const res = await fetch(`${RAW}/${rel}`);
  if (!res.ok) throw new Error(`GET ${rel} -> ${res.status} ${res.statusText}`);
  return res.text();
}

/** `@blue: #519aba;` -> { blue: "#519aba" } */
function parseColors(less) {
  const out = {};
  for (const m of less.matchAll(/^@([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gm)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

/**
 * `.icon-set(".ts", "typescript", @blue);` and the `.icon-partial(…)` form,
 * either quote style. Upstream's partial matching is substring-based; we reduce
 * it to exact-name matching (only ~48 entries, and the curated ones — LICENSE —
 * are whole filenames in practice).
 */
function parseMapping(less) {
  const suffixes = new Map();
  const names = new Map();
  const re =
    /\.icon-(?:set|partial)\(\s*(['"])(.+?)\1\s*,\s*(['"])(.+?)\3\s*,\s*@([a-z0-9-]+)\s*\)/g;
  for (const m of less.matchAll(re)) {
    const key = m[2];
    const entry = { icon: m[4], colorVar: m[5] };
    // A leading dot means "matches the end of a filename" — which covers both
    // real extensions (".ts") and dotfiles (".gitignore"), since the runtime
    // resolver walks dotted suffixes of the basename. Everything else is a
    // whole filename. First win: upstream states the generic rule before later
    // overrides, and taking the first keeps regeneration stable.
    const target = key.startsWith(".") ? suffixes : names;
    if (!target.has(key)) target.set(key, entry);
  }
  return { suffixes, names };
}

/**
 * Pull the geometry out of a seti icon. Every `<path>` is emitted separately,
 * keeping its own fill-rule/clip-rule (yml.svg needs evenodd) — nothing is
 * concatenated, so multi-path icons stay correct. Fails loudly on anything the
 * emitted shape can't carry: non-<path> geometry, a `transform`, or more than
 * one distinct fill (which flattening to `currentColor` would wreck).
 */
function parseSvg(name, svg) {
  const fail = (why) => {
    throw new Error(
      `icons/${name}.svg: ${why}. Either drop it from the curated list or widen ` +
        `the emitted representation — never emit half an icon.`,
    );
  };

  // Most seti icons are 32x32, but not all — `default.svg` is "0 0 1200 1000"
  // and `vite.svg` is "-75 -105 560 554". Each icon therefore carries its own
  // viewBox, passed through verbatim, rather than sharing a constant.
  const open = svg.match(/<svg[^>]*>/)?.[0] ?? "";
  let viewBox = open.match(/viewBox="(-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+)"/)?.[1];
  if (!viewBox) {
    // A few icons (tsconfig.svg) size themselves with width/height instead.
    const w = open.match(/\bwidth="([\d.]+)"/)?.[1];
    const h = open.match(/\bheight="([\d.]+)"/)?.[1];
    if (!w || !h) fail("neither a four-number viewBox nor width/height");
    viewBox = `0 0 ${w} ${h}`;
  }

  const body = svg.replace(/<svg[^>]*>/, "").replace(/<\/svg>/, "");
  const foreign = body.match(/<(?!path\b|\/svg\b)([a-zA-Z][\w-]*)/);
  if (foreign) fail(`non-<path> geometry <${foreign[1]}>`);
  if (/\btransform=/.test(body)) fail("carries a transform");

  const paths = [...body.matchAll(/<path\b([^>]*)>/g)].map((m) => {
    const attrs = m[1];
    const d = attrs.match(/\bd="([^"]+)"/)?.[1];
    if (!d) fail("a <path> has no `d`");
    const rule = attrs.match(/\bfill-rule="([^"]+)"/)?.[1];
    const clip = attrs.match(/\bclip-rule="([^"]+)"/)?.[1];
    if (rule && rule !== "evenodd" && rule !== "nonzero") fail(`fill-rule="${rule}"`);
    if (clip && clip !== "evenodd" && clip !== "nonzero") fail(`clip-rule="${clip}"`);
    return { d, fillRule: rule ?? null, clipRule: clip ?? null };
  });
  if (paths.length === 0) fail("no <path> found");

  const fills = new Set(
    [...body.matchAll(/<path\b[^>]*\bfill="([^"]+)"/g)].map((m) => m[1].toLowerCase()),
  );
  if (fills.size > 1) fail(`${fills.size} distinct fills — flattening would wreck it`);

  return { paths, viewBox, fill: [...fills][0] ?? null };
}

function resolve(mapping, colors, key, kind) {
  const table = kind === "name" ? mapping.names : mapping.suffixes;
  const hit = table.get(key);
  if (!hit) {
    throw new Error(
      `mapping.less has no entry for ${kind} ${JSON.stringify(key)} at ${SETI_SHA.slice(0, 8)}. ` +
        `Upstream may have dropped it — remove it from the curated list or pick a new pin.`,
    );
  }
  const hex = colors[hit.colorVar];
  if (!hex) throw new Error(`ui-variables.less has no @${hit.colorVar} (for ${key})`);
  return { icon: hit.icon, color: hex };
}

/**
 * The runtime resolver, replayed here so the "unknown extension falls back to a
 * generic icon" acceptance criterion has a gate. `editor-shell` has no build
 * step and the repo has no DOM test runner, so this is where it gets checked.
 * Must stay in step with resolveFileIcon.ts.
 */
function replayResolve(byName, bySuffix, filePath) {
  const base = filePath.split("/").pop() ?? filePath;
  if (byName[base]) return byName[base];
  const parts = base.split(".");
  for (let i = 1; i < parts.length; i += 1) {
    const suffix = `.${parts.slice(i).join(".")}`;
    if (bySuffix[suffix]) return bySuffix[suffix];
  }
  return null;
}

const FIXTURES = [
  ["src/main.ts", "typescript"],
  ["src/App.test.ts", "typescript"],
  ["index.html", "html"],
  ["styles.css", "css"],
  ["package.json", "json"],
  ["tsconfig.json", "tsconfig"],
  ["pnpm-lock.yaml", "yml"],
  ["vite.config.ts", "vite"],
  ["LICENSE", "license"],
  [".gitignore", "git"],
  ["src/app/data-grid.component.ts", "typescript"],
  ["src/pages/index.astro", null],
  ["Makefile", null],
  ["noextension", null],
];

function ts(value) {
  return JSON.stringify(value);
}

function emitGeometry({ viewBox, paths }) {
  const body = paths
    .map(({ d, fillRule, clipRule }) => {
      const extra = [
        fillRule ? `fillRule: ${ts(fillRule)}` : null,
        clipRule ? `clipRule: ${ts(clipRule)}` : null,
      ].filter(Boolean);
      return `{ d: ${ts(d)}${extra.length ? `, ${extra.join(", ")}` : ""} }`;
    })
    .join(", ");
  return `{ viewBox: ${ts(viewBox)}, paths: [${body}] }`;
}

function emit(entries, indent = "  ") {
  return entries
    .map(([k, v]) => `${indent}${ts(k)}: { icon: ${ts(v.icon)}, color: ${ts(v.color)} },`)
    .join("\n");
}

async function main() {
  const [mappingLess, variablesLess] = await Promise.all([
    fetchText("styles/components/icons/mapping.less"),
    fetchText("styles/ui-variables.less"),
  ]);
  const colors = parseColors(variablesLess);
  const mapping = parseMapping(mappingLess);

  const bySuffix = {};
  for (const key of CURATED_SUFFIXES) bySuffix[key] = resolve(mapping, colors, key, "suffix");
  const byName = {};
  for (const key of CURATED_NAMES) byName[key] = resolve(mapping, colors, key, "name");

  const fallbackColor = colors.white;
  if (!fallbackColor) throw new Error("ui-variables.less has no @white for the fallback icon");
  const fallback = { icon: FALLBACK_ICON, color: fallbackColor };

  const iconNames = [
    ...new Set([
      ...Object.values(bySuffix).map((e) => e.icon),
      ...Object.values(byName).map((e) => e.icon),
      FALLBACK_ICON,
      FOLDER_ICON,
    ]),
  ].sort();

  const svgs = await Promise.all(
    iconNames.map(async (name) => [name, parseSvg(name, await fetchText(`icons/${name}.svg`))]),
  );
  const geometry = Object.fromEntries(
    svgs.map(([name, { paths, viewBox }]) => [name, { paths, viewBox }]),
  );
  const folderFill = svgs.find(([name]) => name === FOLDER_ICON)?.[1].fill;
  if (!folderFill) {
    throw new Error(`icons/${FOLDER_ICON}.svg has no fill to borrow for <FolderIcon />`);
  }
  const folder = { icon: FOLDER_ICON, color: folderFill };

  // Assertions — fail before writing, never emit a table that can't resolve.
  for (const [key, entry] of [...Object.entries(bySuffix), ...Object.entries(byName)]) {
    if (!geometry[entry.icon]) throw new Error(`${key} -> ${entry.icon} has no path data`);
  }
  if (!geometry[FALLBACK_ICON]) throw new Error(`fallback icon ${FALLBACK_ICON} has no path data`);
  if (!geometry[FOLDER_ICON]) throw new Error(`folder icon ${FOLDER_ICON} has no path data`);

  for (const [file, expected] of FIXTURES) {
    const hit = replayResolve(byName, bySuffix, file);
    const actual = hit ? hit.icon : null;
    if (actual !== expected) {
      throw new Error(
        `resolver fixture ${file}: expected ${expected ?? "fallback"}, got ${actual ?? "fallback"}`,
      );
    }
  }

  const sortedSuffixes = Object.entries(bySuffix).sort(
    // Longest first so a plain object literal reads in resolution order; the
    // runtime resolver does its own longest-suffix walk regardless.
    (a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]),
  );
  const sortedNames = Object.entries(byName).sort((a, b) => a[0].localeCompare(b[0]));

  const out = `// GENERATED FILE — do not edit by hand.
//
// Source:    https://github.com/${SETI_REPO} @ ${SETI_SHA}
// Licence:   MIT (Jesse Weed) — https://github.com/${SETI_REPO}/blob/${SETI_SHA}/LICENSE.md
// Regenerate: node scripts/sync-seti-icons.mjs
//
// Colours come from mapping.less + ui-variables.less, not from each SVG's baked
// fill (the two disagree upstream). \`FOLDER\` is the one exception: it has no
// mapping entry, so it borrows its own fill. These hex literals are the third
// documented exception to the "only theme.ts may hold a colour literal" rule —
// they're upstream brand colours and identical in both themes. See ADR-0024.

/** A resolved file-type icon: geometry key + the colour seti draws it in. */
export type SetiEntry = { readonly icon: string; readonly color: string };

/** One \`<path>\`, drawn with \`fill="currentColor"\`. */
export type SetiPath = {
  readonly d: string;
  readonly fillRule?: "evenodd" | "nonzero";
  readonly clipRule?: "evenodd" | "nonzero";
};

/** An icon's geometry. Most are 32x32, but not all — carry the viewBox with the paths. */
export type SetiGeometry = { readonly viewBox: string; readonly paths: readonly SetiPath[] };

/** Exact filename match — checked before any suffix. */
export const SETI_BY_NAME: Readonly<Record<string, SetiEntry>> = {
${emit(sortedNames)}
};

/** Dotted suffix match — longest first, so ".test.ts" beats ".ts". */
export const SETI_BY_SUFFIX: Readonly<Record<string, SetiEntry>> = {
${emit(sortedSuffixes)}
};

/** Rendered when nothing above matches. */
export const SETI_FALLBACK: SetiEntry = { icon: ${ts(fallback.icon)}, color: ${ts(fallback.color)} };

/** Directory rows in the file tree. */
export const SETI_FOLDER: SetiEntry = { icon: ${ts(folder.icon)}, color: ${ts(folder.color)} };

/** Icon name -> geometry. */
export const SETI_GEOMETRY: Readonly<Record<string, SetiGeometry>> = {
${iconNames.map((n) => `  ${ts(n)}: ${emitGeometry(geometry[n])},`).join("\n")}
};
`;

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, out);
  console.log(
    `wrote ${path.relative(RUNNER_DIR, OUT_FILE)} — ${iconNames.length} icons, ` +
      `${sortedSuffixes.length} suffixes, ${sortedNames.length} names, ` +
      `${FIXTURES.length} resolver fixtures passed`,
  );
}

await main();
