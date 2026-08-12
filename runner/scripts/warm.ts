// Prebuild the latest N Handsontable versions × the catalog and push them to R2,
// so client links and docs embeds are instant (built + cached forever per
// (framework, version, files-hash)). Uses the deployed render endpoint
// (/r/:framework?v=…) so it reuses the exact prod build + cache path.
//
// Optionally warms one Tier-2 container per framework (best-effort).
//
// Usage:
//   node scripts/warm.ts
//   WARM_API_BASE=https://demos.handsontable.com \
//   WARM_VERSIONS=3 WARM_EXAMPLES=react,vue,remix WARM_CONCURRENCY=3 \
//   WARM_TIER2_CONTAINERS=1 node scripts/warm.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "..");

const API_BASE = process.env.WARM_API_BASE || "https://demos.handsontable.com";
const N = Math.max(1, Number.parseInt(process.env.WARM_VERSIONS || "3", 10) || 3);
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.WARM_CONCURRENCY || "3", 10) || 3);
const MIN_MAJOR = 15;
const MAX_MAJOR = 19;

const catalog = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "catalog.json"), "utf8"));
const allFrameworks: string[] = catalog.examples.map((e: { framework: string }) => e.framework);
const tier2: string[] = catalog.examples.filter((e: { tier: number }) => e.tier === 2).map((e: { framework: string }) => e.framework);

// catalog.json is the files-free index (DEV-2213); container warming posts the
// starter's actual files, which live in the bucket snapshot.
const WARM_BUCKET = process.env.WARM_BUCKET || "18";
const starterFiles = (framework: string): Record<string, string> =>
  JSON.parse(
    fs.readFileSync(
      path.join(RUNNER_DIR, "apps", "authoring", "public", "starter-examples", WARM_BUCKET, `${framework}.json`),
      "utf8",
    ),
  ).files;

const examples = process.env.WARM_EXAMPLES
  ? process.env.WARM_EXAMPLES.split(",").map((s) => s.trim()).filter(Boolean)
  : allFrameworks;

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function topVersions(n: number): Promise<string[]> {
  const res = await fetch("https://registry.npmjs.org/handsontable");
  const data = (await res.json()) as { versions: Record<string, unknown> };
  return Object.keys(data.versions)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v)) // stable only
    .filter((v) => {
      const major = Number(v.split(".")[0]);
      return major >= MIN_MAJOR && major <= MAX_MAJOR;
    })
    .sort(cmpSemver)
    .slice(0, n);
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>, size: number) {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function warmRender(framework: string, version: string) {
  const url = `${API_BASE}/r/${encodeURIComponent(framework)}?v=${encodeURIComponent(version)}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual" });
    const ok = res.status === 302 || res.status === 200;
    console.log(`[warm] ${ok ? "ok" : `HTTP ${res.status}`} ${framework}@${version} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.warn(`[warm] FAIL ${framework}@${version}: ${(e as Error).message}`);
  }
}

async function warmTier2Container(framework: string) {
  const files = Object.fromEntries(
    Object.entries(starterFiles(framework)).map(([path, contents]) => [path.startsWith("/") ? path.slice(1) : path, contents]),
  );
  try {
    const res = await fetch(`${API_BASE}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ framework, files }),
    });
    console.log(`[warm] container ${framework}: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[warm] container FAIL ${framework}: ${(e as Error).message}`);
  }
}

async function main() {
  const versions = await topVersions(N);
  console.log(`[warm] API=${API_BASE}`);
  console.log(`[warm] versions (top ${N}, majors ${MIN_MAJOR}-${MAX_MAJOR}): ${versions.join(", ")}`);
  console.log(`[warm] examples (${examples.length}): ${examples.join(", ")}`);

  const jobs: Array<{ framework: string; version: string }> = [];
  for (const framework of examples) for (const version of versions) jobs.push({ framework, version });
  console.log(`[warm] prebuilding ${jobs.length} (framework × version) renders, concurrency ${CONCURRENCY}…`);
  await pool(jobs, (j) => warmRender(j.framework, j.version), CONCURRENCY);

  if (process.env.WARM_TIER2_CONTAINERS === "1") {
    console.log(`[warm] warming ${tier2.length} Tier-2 containers…`);
    await pool(tier2, warmTier2Container, 2);
  }

  console.log("[warm] done.");
}

main();
