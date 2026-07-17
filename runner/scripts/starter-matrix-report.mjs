// Turn Playwright JSON reporter output from `pnpm e2e:matrix` into a
// markdown starter × major compatibility table (DEV-2102 / ADR-0021 decision
// 10). Accepts one or more results files (the matrix is run in chunks against
// prod, each writing its own JSON — this merges them). Writes
// docs/reports/starter-matrix-<date>.md and echoes the report to stdout.
//
// Usage: node scripts/starter-matrix-report.mjs [path/to/results.json ...]
//        (defaults to test-results/starter-matrix.json when no args given)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.resolve(__dirname, "..");

const resultsPaths = (process.argv.length > 2 ? process.argv.slice(2) : ["test-results/starter-matrix.json"]).map(
  (p) => path.resolve(RUNNER_DIR, p),
);

const missing = resultsPaths.filter((p) => !fs.existsSync(p));
if (missing.length > 0) {
  console.error(`Missing results file(s):\n${missing.join("\n")}\nRun \`pnpm e2e:matrix\` first.`);
  process.exit(1);
}

const TITLE_RE = /^matrix: (.+) @ (\d+) \[(\w+)\]$/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => (typeof s === "string" ? s.replace(ANSI_RE, "") : s);

// combo key -> { framework, engine, results: Map<major, {status, resolvedVersion, detectedVersion, error}> }
const combos = new Map();

function walkSuites(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const match = TITLE_RE.exec(spec.title);
        if (!match) continue;
        const [, framework, majorStr, engine] = match;
        const major = Number(majorStr);

        const lastResult = t.results?.[t.results.length - 1];
        const status = t.status; // "expected" | "unexpected" | "flaky" | "skipped"

        const annotations = Object.fromEntries(
          (t.annotations ?? []).map((a) => [a.type, a.description]),
        );

        const errorMessage = stripAnsi(lastResult?.error?.message ?? lastResult?.errors?.[0]?.message ?? null);

        if (!combos.has(framework)) combos.set(framework, { framework, engine, results: new Map() });
        // Later files win on overlap (e.g. a rerun of a previously-killed chunk).
        combos.get(framework).results.set(major, {
          status,
          resolvedVersion: annotations.resolvedVersion ?? null,
          detectedVersion: annotations.detectedVersion ?? null,
          error: errorMessage,
        });
      }
    }
    walkSuites(suite.suites);
  }
}

for (const resultsPath of resultsPaths) {
  const raw = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  walkSuites(raw.suites);
}

if (combos.size === 0) {
  console.error("No `matrix: ...` tests found in results file — did the matrix spec actually run?");
  process.exit(1);
}

const MAJORS = [15, 16, 17, 18, 19];

const STATUS_ICON = {
  expected: "✅",
  flaky: "⚠️",
  unexpected: "❌",
  skipped: "⏭️",
  missing: "❓",
};

function cell(result) {
  if (!result) return STATUS_ICON.missing;
  const icon = STATUS_ICON[result.status] ?? STATUS_ICON.missing;
  const version = result.resolvedVersion ? ` ${result.resolvedVersion}` : "";
  const verified = result.detectedVersion && result.detectedVersion !== "unverified" ? "v" : "";
  return `${icon}${verified}${version}`;
}

const sortedFrameworks = [...combos.values()].sort((a, b) => a.framework.localeCompare(b.framework));

const lines = [];
lines.push(`# Starter compatibility matrix`);
lines.push("");
lines.push(`Generated from ${resultsPaths.map((p) => `\`${path.relative(RUNNER_DIR, p)}\``).join(", ")}.`);
lines.push("");
lines.push(
  `Legend: ✅ passed, ✅v passed with in-frame version verified, ⚠️ flaky (passed on retry), ❌ failed, ⏭️ skipped, ❓ no result found.`,
);
lines.push("");
lines.push(`| starter (engine) | ${MAJORS.map((m) => `${m}.x`).join(" | ")} |`);
lines.push(`|---|${MAJORS.map(() => "---").join("|")}|`);
for (const { framework, engine, results } of sortedFrameworks) {
  const row = MAJORS.map((m) => cell(results.get(m)));
  lines.push(`| ${framework} (${engine}) | ${row.join(" | ")} |`);
}

const failures = [];
for (const { framework, engine, results } of sortedFrameworks) {
  for (const major of MAJORS) {
    const r = results.get(major);
    if (r && (r.status === "unexpected" || r.status === "flaky")) {
      failures.push({ framework, engine, major, ...r });
    }
  }
}

if (failures.length > 0) {
  lines.push("");
  lines.push(`## Failures / flaky (${failures.length})`);
  lines.push("");
  for (const f of failures) {
    lines.push(`### ${f.framework} @ ${f.major} [${f.engine}] — ${f.status}`);
    lines.push("");
    lines.push(`- resolved version: ${f.resolvedVersion ?? "unknown"}`);
    if (f.error) {
      lines.push("");
      lines.push("```");
      lines.push(f.error.split("\n").slice(0, 15).join("\n"));
      lines.push("```");
    }
    lines.push("");
  }
} else {
  lines.push("");
  lines.push("No failures.");
}

lines.push("");
lines.push(
  "Note: container-engine starters verify only that the requested version reached the session " +
    "(package.json pin); in-frame `Handsontable.version` is typically unavailable for ESM bundles " +
    "and is reported as `unverified` rather than a failure.",
);

const report = lines.join("\n") + "\n";

const today = new Date().toISOString().slice(0, 10);
const outDir = path.join(RUNNER_DIR, "docs", "reports");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `starter-matrix-${today}.md`);
fs.writeFileSync(outPath, report);

console.log(report);
console.error(`\nWrote ${path.relative(RUNNER_DIR, outPath)}`);
