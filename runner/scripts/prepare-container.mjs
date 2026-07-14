// Generate the Tier-2 container assets from the catalog:
//   - containers/live/Dockerfile        one generic image with each container
//                                       framework's node_modules baked into
//                                       /baked/<key> (fast, install-free boots)
//   - containers/live/baked/<key>/package.json   deps to bake (default version)
//   - workers/api/src/frameworks.generated.ts    FRAMEWORK_DEV + BUILD_CONFIG
//
// The live image is shared by ALL container-engine examples (proxyToSandbox
// needs one `Sandbox` namespace). At session start the Worker hardlink-copies
// the baked node_modules into /app, so a default-version boot skips install.
//
// Usage: node scripts/prepare-container.mjs

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
const DEV = {
  remix: { cmd: "pnpm run dev -- --host 0.0.0.0 --port 5173", port: 5173 },
  angular: { cmd: "pnpm exec ng serve --host 0.0.0.0 --port 4200 --disable-host-check", port: 4200 },
  "next.js": { cmd: "pnpm exec next dev -p 3001 -H 0.0.0.0", port: 3001 },
  "next-shadcn.js": { cmd: "pnpm exec next dev -p 3001 -H 0.0.0.0", port: 3001 },
  astro: { cmd: "pnpm exec astro dev --host 0.0.0.0 --port 4321", port: 4321 },
  nuxt: { cmd: "pnpm exec nuxt dev -H 0.0.0.0 -p 3001", port: 3001 },
  "react-js": { cmd: "pnpm run dev -- --host 0.0.0.0 --port 5173", port: 5173 },
  "ant-design": { cmd: "pnpm run dev -- --host 0.0.0.0 --port 5173", port: 5173 },
  mui: { cmd: "pnpm run dev -- --host 0.0.0.0 --port 5173", port: 5173 },
  "base-web": { cmd: "pnpm run dev -- --host 0.0.0.0 --port 5173", port: 5173 },
  // Documentation-guide Vue examples use `<script setup>` (unsupported by the
  // in-browser bundler), so they run on the container engine via real Vite.
  vue: { cmd: "pnpm exec vite --host 0.0.0.0 --port 5173", port: 5173 },
};

// Container frameworks that are NOT catalog starters but must still be baked
// into the shared image (used only by the documentation-guide examples). Vue's
// starter is Tier-1 (Sandpack), but its docs examples need a real Vite server.
const EXTRA_CONTAINER = [
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
            handsontable: "18.0.0",
            "@handsontable/vue3": "18.0.0",
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

const catalog = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "catalog.json"), "utf8"));
const bakedKey = (framework) => framework.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const dependencyMetadataFingerprint = ({ packageJson, pnpmLock }) => {
  const part = (name, value) => value === undefined ? `${name}:missing\n` : `${name}:${value.length}:${value}\n`;
  return createHash("sha256").update(`${part("package.json", packageJson)}${part("pnpm-lock.yaml", pnpmLock)}`).digest("hex");
};

const containerExamples = catalog.examples.filter((e) => e.engine === "container");
// Everything baked into the image + given a dev command: catalog container
// examples plus the docs-only extras (e.g. Vue).
const bakeExamples = [...containerExamples, ...EXTRA_CONTAINER];

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
  for (const e of bakeExamples) {
    if (!DEV[e.framework]) throw new Error(`no DEV command for container framework: ${e.framework}`);
    const key = bakedKey(e.framework);
    const dir = path.join(bakedRoot, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), e.files["/package.json"]);
    const lock = e.files["/pnpm-lock.yaml"] ?? writeExtraLock(dir);
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), lock);
    steps.push(
      `# ${e.framework}\nCOPY baked/${key}/package.json baked/${key}/pnpm-lock.yaml /baked/${key}/\nRUN cd /baked/${key} && ${e.installCommand}`,
    );
  }

  const dockerfile = `# Generated by scripts/prepare-container.mjs — do not edit by hand.
# One generic Tier-2 image. Each framework's node_modules is baked into
# /baked/<key>; the Worker hardlink-copies the right one into /app at session
# start so a default-version boot skips \`pnpm install\`. proxyToSandbox requires
# a single \`Sandbox\` namespace, hence one shared image.
FROM ${SANDBOX_IMAGE}

WORKDIR /app

RUN ${COREPACK_BIN} enable --install-directory /usr/local/bin \\
  && ${COREPACK_BIN} prepare pnpm@${PNPM_VERSION} --activate

${steps.join("\n\n")}

EXPOSE ${EXPOSE_PORTS.join(" ")}
`;
  fs.writeFileSync(path.join(liveDir, "Dockerfile"), dockerfile);
  console.log(`[prepare-container] baked ${bakeExamples.length} frameworks into containers/live/`);
}

function writeGenerated() {
  const devRows = bakeExamples.map((e) => {
    const d = DEV[e.framework];
    const bakedDir = path.join(RUNNER_DIR, "containers", "live", "baked", bakedKey(e.framework));
    const sourceDependencyFingerprint = dependencyMetadataFingerprint({
      packageJson: fs.readFileSync(path.join(bakedDir, "package.json"), "utf8"),
      pnpmLock: fs.readFileSync(path.join(bakedDir, "pnpm-lock.yaml"), "utf8"),
    });
    return `  ${JSON.stringify(e.framework)}: { cmd: ${JSON.stringify(d.cmd)}, port: ${d.port}, bakedKey: ${JSON.stringify(bakedKey(e.framework))}, sourceDependencyFingerprint: ${JSON.stringify(sourceDependencyFingerprint)} },`;
  });
  const buildRows = catalog.examples.map((e) =>
    `  ${JSON.stringify(e.framework)}: { tier: ${e.tier}, installCommand: ${JSON.stringify(e.installCommand)}, buildCommand: ${JSON.stringify(e.buildCommand)}, outputDir: ${JSON.stringify(e.outputDir)}, outputGlob: ${e.outputGlob ? JSON.stringify(e.outputGlob) : "null"} },`,
  );

  const out = `// Generated by scripts/prepare-container.mjs — do not edit by hand.

// Container-engine framework -> dev command, port, and baked-deps key.
export interface FrameworkDev {
  cmd: string;
  port: number;
  bakedKey: string;
  sourceDependencyFingerprint: string;
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

writeBakedContexts();
writeGenerated();
console.log(`[prepare-container] container examples: ${containerExamples.map((e) => e.framework).join(", ")}`);
