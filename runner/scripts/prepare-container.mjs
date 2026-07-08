// Populate a Tier-2 container build context from the catalog. For now it writes
// the framework's package.json next to its Dockerfile so `docker build` can bake
// deps. Source files are written per-session at runtime by the Worker.
//
// Usage: node scripts/prepare-container.mjs <framework>   (e.g. remix)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "..");

const framework = process.argv[2];
if (!framework) {
  console.error("usage: node scripts/prepare-container.mjs <framework>");
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "catalog.json"), "utf8"));
const entry = catalog.examples.find((e) => e.framework === framework);
if (!entry) {
  console.error(`unknown framework: ${framework}`);
  process.exit(1);
}
if (entry.tier !== 2) {
  console.error(`${framework} is Tier ${entry.tier}; only Tier-2 frameworks use containers`);
  process.exit(1);
}

const pkg = entry.files["/package.json"];
if (!pkg) {
  console.error(`${framework}: no /package.json in catalog`);
  process.exit(1);
}

const outDir = path.join(RUNNER_DIR, "containers", entry.container);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "package.json"), pkg);
console.log(`[prepare-container] wrote ${path.relative(RUNNER_DIR, path.join(outDir, "package.json"))}`);
console.log(`[prepare-container] container=${entry.container} devCommand=${entry.devCommand} port=${entry.port}`);
