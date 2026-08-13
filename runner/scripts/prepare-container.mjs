// Generate the Tier-2 container assets from the catalog:
//   - containers/live/Dockerfile        one generic image with each container
//                                       framework's node_modules baked into
//                                       /baked/<key> (fast frozen pnpm reconciliation)
//   - containers/live/baked/<key>/package.json   deps to bake (default version)
//   - workers/api/src/frameworks.generated.ts    FRAMEWORK_DEV + BUILD_CONFIG
//
// The live image is shared by ALL container-engine examples (proxyToSandbox
// needs one `Sandbox` namespace). At session start the Worker hardlink-copies
// the baked node_modules into /app, then runs fast frozen pnpm reconciliation.
//
// Usage: node scripts/prepare-container.mjs [--seed-bucket=18] [--generated-only]
//
// `--generated-only` rewrites frameworks.generated.ts and leaves the committed
// baked contexts + Dockerfile untouched. Adding a Tier-1 starter (e.g. the blank
// templates, DEV-2499) changes BUILD_CONFIG but nothing about the image, and a
// full run would re-resolve the docs-only Vue lockfile over the network.
//
// Starter sources come from the versioned bucket snapshots (DEV-2213):
// apps/authoring/public/starter-examples/<bucket>/<framework>.json.
//
// One baked node_modules per framework (the seed bucket's), but a dependency
// fingerprint per (framework, bucket) — every bucket's pristine session gets
// the frozen install path while the image carries a single seed. This works
// because the seed is only a warm cache: the boot script hardlink-copies it,
// then `pnpm install --frozen-lockfile` reconciles node_modules to the
// SUBMITTED package.json + lock, which every bucket artifact keeps
// self-consistent by construction. Buckets differ only in the Handsontable
// core + wrapper pins, so reconciliation downloads two or three packages, not
// a tree. Baking every bucket instead (24+ contexts) doubled the image and
// stalled `wrangler deploy` in the image-export phase — hence one seed.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "..");

// Base image tag MUST match the installed @cloudflare/sandbox version.
const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.3";
const PNPM_VERSION = "10.34.5";
// sandbox:0.12.3 bundles Corepack but omits its command shim.
const COREPACK_BIN = "node /usr/local/lib/node_modules/corepack/dist/corepack.js";

// Dev-server command + port per framework. NOTE: port 3000 is reserved by the
// Cloudflare Sandbox control plane — dev servers must use another port.
// NOTE: use `pnpm exec <bin> <flags>`, not `pnpm run <script> -- <flags>` — pnpm
// (unlike npm) does not strip the `--` separator when the script resolves to a
// real binary, so the binary receives a literal "--" as its first arg and its
// CLI treats everything after it as positional, silently dropping --host/--port.
const DEV = {
  remix: { cmd: "pnpm exec remix vite:dev --host 0.0.0.0 --port 5173", port: 5173 },
  angular: { cmd: "pnpm exec ng serve --host 0.0.0.0 --port 4200 --disable-host-check", port: 4200 },
  "next.js": { cmd: "pnpm exec next dev -p 3001 -H 0.0.0.0", port: 3001 },
  "next-shadcn.js": { cmd: "pnpm exec next dev -p 3001 -H 0.0.0.0", port: 3001 },
  astro: { cmd: "pnpm exec astro dev --host 0.0.0.0 --port 4321", port: 4321 },
  // NOTE: nuxt's CLI has no `-H` alias (host is `--host`/`-h`); an unknown flag
  // makes it swallow `0.0.0.0` as the positional rootDir and serve an empty app.
  nuxt: { cmd: "pnpm exec nuxt dev --host 0.0.0.0 --port 3001", port: 3001 },
  "react-js": { cmd: "pnpm exec vite --host 0.0.0.0 --port 5173", port: 5173 },
  "ant-design": { cmd: "pnpm exec vite --host 0.0.0.0 --port 5173", port: 5173 },
  mui: { cmd: "pnpm exec vite --host 0.0.0.0 --port 5173", port: 5173 },
  "base-web": { cmd: "pnpm exec vite --host 0.0.0.0 --port 5173", port: 5173 },
  "fluent-ui": { cmd: "pnpm exec vite --host 0.0.0.0 --port 5173", port: 5173 },
  // Documentation-guide Vue examples use `<script setup>` (unsupported by the
  // in-browser bundler), so they run on the container engine via real Vite.
  vue: { cmd: "pnpm exec vite --host 0.0.0.0 --port 5173", port: 5173 },
};

// Container frameworks that are NOT catalog starters but must still be baked
// into the shared image (used only by the documentation-guide examples). Vue's
// starter is Tier-1 (Sandpack), but its docs examples need a real Vite server.
// Pinned to the baked bucket's hotVersion, like every real starter context.
const extraContainer = (hotVersion) => [
  {
    framework: "vue",
    tier: 1,
    installCommand: "pnpm install --frozen-lockfile",
    buildCommand: "vite build",
    outputDir: "dist",
    outputGlob: null,
    files: {
      "/package.json": JSON.stringify(
        {
          name: "handsontable-vue-docs",
          version: "1.0.0",
          private: true,
          packageManager: `pnpm@${PNPM_VERSION}`,
          dependencies: {
            handsontable: hotVersion,
            "@handsontable/vue3": hotVersion,
            vue: "3.x",
            vite: "^5.4.0",
            "@vitejs/plugin-vue": "^5.0.0",
          },
          scripts: { start: "vite", build: "vite build" },
        },
        null,
        2,
      ),
    },
  },
];
const EXPOSE_PORTS = [...new Set(Object.values(DEV).map((d) => d.port))].sort();

// The one bucket whose node_modules is baked into the image. Every other
// bucket's pristine session seeds it and lets the frozen reconciliation fetch
// the Handsontable delta.
const SEED_BUCKET =
  process.argv.find((a) => a.startsWith("--seed-bucket="))?.slice("--seed-bucket=".length) ?? "18";
const STARTER_EXAMPLES_DIR = path.join(RUNNER_DIR, "apps", "authoring", "public", "starter-examples");

// catalog.json is the files-free index; full starter artifacts (with files)
// come from the bucket snapshots.
const catalog = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "catalog.json"), "utf8"));
const loadBucketManifest = (bucket) =>
  JSON.parse(fs.readFileSync(path.join(STARTER_EXAMPLES_DIR, bucket, "manifest.json"), "utf8"));
const loadBucketArtifact = (bucket, framework) =>
  JSON.parse(fs.readFileSync(path.join(STARTER_EXAMPLES_DIR, bucket, `${framework}.json`), "utf8"));
const bakedKey = (framework) => framework.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const dependencyMetadataFingerprint = ({ packageJson, pnpmLock }) => {
  const part = (name, value) => value === undefined ? `${name}:missing\n` : `${name}:${value.length}:${value}\n`;
  return createHash("sha256").update(`${part("package.json", packageJson)}${part("pnpm-lock.yaml", pnpmLock)}`).digest("hex");
};

const containerFrameworks = catalog.examples.filter((e) => e.engine === "container");
// Everything baked into the image + given a dev command: the seed bucket's
// container starters plus the docs-only extras (e.g. Vue).
const seedManifest = loadBucketManifest(SEED_BUCKET);
const seedFrameworks = new Set(seedManifest.examples.map((m) => m.framework));
const bakeEntries = [];
for (const e of [
  ...containerFrameworks
    .filter((e) => seedFrameworks.has(e.framework))
    .map((e) => loadBucketArtifact(SEED_BUCKET, e.framework)),
  ...extraContainer(seedManifest.hotVersion),
]) {
  bakeEntries.push({ bucket: SEED_BUCKET, example: e, key: `${bakedKey(e.framework)}-${SEED_BUCKET}` });
}
for (const e of containerFrameworks) {
  if (!seedFrameworks.has(e.framework)) {
    throw new Error(`container framework ${e.framework} missing from seed bucket ${SEED_BUCKET}`);
  }
}

// Frozen-install fingerprints, one per (framework, bucket) across EVERY bucket
// on disk — all pointing at the framework's single seed context. Computed from
// the bucket artifacts directly; no baked directory exists for non-seed
// buckets.
const bucketKeys = fs
  .readdirSync(STARTER_EXAMPLES_DIR)
  .filter((name) => fs.existsSync(path.join(STARTER_EXAMPLES_DIR, name, "manifest.json")));
const starterContexts = new Map(); // framework -> [{bucket, bakedKey, fingerprint}]
for (const bucket of bucketKeys) {
  const inBucket = new Set(loadBucketManifest(bucket).examples.map((m) => m.framework));
  for (const fw of containerFrameworks.map((e) => e.framework)) {
    if (!inBucket.has(fw)) continue; // below the minCoreMajor floor in this bucket
    const artifact = loadBucketArtifact(bucket, fw);
    const list = starterContexts.get(fw) ?? [];
    list.push({
      bucket,
      bakedKey: `${bakedKey(fw)}-${SEED_BUCKET}`,
      fingerprint: dependencyMetadataFingerprint({
        packageJson: artifact.files["/package.json"],
        pnpmLock: artifact.files["/pnpm-lock.yaml"],
      }),
    });
    starterContexts.set(fw, list);
  }
}

function writeExtraLock(dir) {
  execFileSync(
    "corepack",
    ["pnpm", "install", "--lockfile-only", "--ignore-scripts", "--ignore-workspace"],
    { cwd: dir, stdio: "inherit" },
  );
  return fs.readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
}

function writeBakedContexts() {
  const liveDir = path.join(RUNNER_DIR, "containers", "live");
  const bakedRoot = path.join(liveDir, "baked");
  fs.rmSync(bakedRoot, { recursive: true, force: true });

  const steps = [];
  for (const { bucket, example: e, key } of bakeEntries) {
    if (!DEV[e.framework]) throw new Error(`no DEV command for container framework: ${e.framework}`);
    const dir = path.join(bakedRoot, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), e.files["/package.json"]);
    const lock = e.files["/pnpm-lock.yaml"] ?? writeExtraLock(dir);
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), lock);
    steps.push(
      `# ${e.framework} (bucket ${bucket})\nCOPY baked/${key}/package.json baked/${key}/pnpm-lock.yaml /baked/${key}/\nRUN cd /baked/${key} && ${e.installCommand}`,
    );
  }

  const dockerfile = `# Generated by scripts/prepare-container.mjs — do not edit by hand.
# One generic Tier-2 image. Each framework's node_modules is baked into
# /baked/<key>; the Worker hardlink-copies the right one into /app at session
# start, then runs fast frozen pnpm reconciliation. proxyToSandbox requires
# a single \`Sandbox\` namespace, hence one shared image.
FROM ${SANDBOX_IMAGE}

WORKDIR /app

RUN ${COREPACK_BIN} enable --install-directory /usr/local/bin \\
  && ${COREPACK_BIN} prepare pnpm@${PNPM_VERSION} --activate

${steps.join("\n\n")}

EXPOSE ${EXPOSE_PORTS.join(" ")}
`;
  fs.writeFileSync(path.join(liveDir, "Dockerfile"), dockerfile);
  console.log(
    `[prepare-container] baked ${bakeEntries.length} seed contexts (bucket ${SEED_BUCKET}) into containers/live/`,
  );
}

function writeGenerated() {
  const devRows = [...new Set(bakeEntries.map((be) => be.example.framework))].map((framework) => {
    const d = DEV[framework];
    const seedKey = `${bakedKey(framework)}-${SEED_BUCKET}`;
    // Starter contexts span every bucket; docs-only extras (vue) have no
    // bucket artifacts, so their single context hashes the baked files.
    let contexts = (starterContexts.get(framework) ?? []).map(
      ({ bucket, bakedKey: key, fingerprint }) =>
        `{ bucket: ${JSON.stringify(bucket)}, bakedKey: ${JSON.stringify(key)}, sourceDependencyFingerprint: ${JSON.stringify(fingerprint)} }`,
    );
    if (!contexts.length) {
      const bakedDir = path.join(RUNNER_DIR, "containers", "live", "baked", seedKey);
      const fingerprint = dependencyMetadataFingerprint({
        packageJson: fs.readFileSync(path.join(bakedDir, "package.json"), "utf8"),
        pnpmLock: fs.readFileSync(path.join(bakedDir, "pnpm-lock.yaml"), "utf8"),
      });
      contexts = [
        `{ bucket: ${JSON.stringify(SEED_BUCKET)}, bakedKey: ${JSON.stringify(seedKey)}, sourceDependencyFingerprint: ${JSON.stringify(fingerprint)} }`,
      ];
    }
    return `  ${JSON.stringify(framework)}: { cmd: ${JSON.stringify(d.cmd)}, port: ${d.port}, defaultBakedKey: ${JSON.stringify(seedKey)}, contexts: [${contexts.join(", ")}] },`;
  });
  const buildRows = catalog.examples.map((e) =>
    `  ${JSON.stringify(e.framework)}: { tier: ${e.tier}, installCommand: ${JSON.stringify(e.installCommand)}, buildCommand: ${JSON.stringify(e.buildCommand)}, outputDir: ${JSON.stringify(e.outputDir)}, outputGlob: ${e.outputGlob ? JSON.stringify(e.outputGlob) : "null"} },`,
  );

  const out = `// Generated by scripts/prepare-container.mjs — do not edit by hand.

// One frozen-install fingerprint per (framework, bucket), all pointing at the
// framework's single seed context: the fingerprint proves the session mounts a
// generator-produced package.json+lock verbatim, and the seeded node_modules
// is only a warm cache the frozen reconciliation adjusts to that lock.
export interface FrameworkDevContext {
  bucket: string;
  bakedKey: string;
  sourceDependencyFingerprint: string;
}

// Container-engine framework -> dev command, port, and baked-deps contexts.
export interface FrameworkDev {
  cmd: string;
  port: number;
  defaultBakedKey: string;
  contexts: FrameworkDevContext[];
}

export const FRAMEWORK_DEV: Record<string, FrameworkDev> = {
${devRows.join("\n")}
};

// Build config for the share snapshotter (all examples).
export interface BuildConfig {
  tier: number;
  installCommand: string;
  buildCommand: string;
  outputDir: string;
  outputGlob: string | null;
}

export const BUILD_CONFIG: Record<string, BuildConfig> = {
${buildRows.join("\n")}
};
`;
  const outPath = path.join(RUNNER_DIR, "workers", "api", "src", "frameworks.generated.ts");
  fs.writeFileSync(outPath, out);
  console.log(`[prepare-container] wrote ${path.relative(RUNNER_DIR, outPath)}`);
}

const generatedOnly = process.argv.includes("--generated-only");
if (!generatedOnly) writeBakedContexts();
writeGenerated();
console.log(
  generatedOnly
    ? "[prepare-container] --generated-only: baked contexts and Dockerfile left untouched"
    : `[prepare-container] container examples: ${containerFrameworks.map((e) => e.framework).join(", ")}`,
);
