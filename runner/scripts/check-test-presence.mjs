// Test-presence gate: a change to runner source must ship a matching test
// change. Ported from the handsontable monorepo's presence gate
// (.github/scripts/test-presence-gate.mjs there), adapted to this repo's two
// test homes. The full decision rules live in runner/docs/TESTING.md.
//
//   Source   = runner/(apps|packages|workers)/**/*.{ts,tsx}, minus declaration
//              files (*.d.ts), generated modules (*.generated.ts), and
//              anything under a public/ directory (imported bucket content,
//              not code).
//   Coverage = any changed runner/e2e/**/*.spec.ts (Playwright) or
//              runner/pipeline/**/*.test.mjs (node --test). Any git status
//              counts — adding, editing, or deleting a test is a test change.
//   Escape   = a `Refactor-only: <reason>` trailer (pure refactor, no behavior
//              change) or a `Test-plan: <reason>` trailer (the test lands in a
//              named follow-up or an existing spec already proves it) on any
//              commit in the PR range. The reason is mandatory — an empty
//              trailer does not pass.
//
// Usage: node runner/scripts/check-test-presence.mjs [<base-ref>]
//        Falls back to $GITHUB_BASE_REF (set on pull_request events), trying
//        `origin/<ref>` when the bare name does not resolve. With no base at
//        all (a branch push, a local run outside a PR) it skips cleanly —
//        a gate that false-blocks gets disabled, which is worse than no gate.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = [/^runner\/(apps|packages|workers)\/.+\.(ts|tsx)$/];

const NOT_SOURCE = [
  /\.d\.ts$/,
  /\.generated\.ts$/,
  /\/public\//,
  // Defensive: a test file that ever gets colocated with source is not source.
  /\.(test|spec)\.[jt]sx?$/,
  /\.test\.mjs$/,
];

const COVERAGE = [
  /^runner\/e2e\/.+\.spec\.ts$/,
  /^runner\/pipeline\/.+\.test\.mjs$/,
];

const TRAILER = /^(Refactor-only|Test-plan):\s*\S/i;

/**
 * Is this path production source that requires a test change?
 * @param {string} path repo-relative path
 */
export function isSource(path) {
  return SOURCE.some((re) => re.test(path)) && !NOT_SOURCE.some((re) => re.test(path));
}

/**
 * Does this path count as test coverage? Status-independent: a modified or
 * deleted spec is still a deliberate test change riding with the source.
 * @param {string} path repo-relative path
 */
export function isCoverage(path) {
  return COVERAGE.some((re) => re.test(path));
}

/**
 * Does any commit message in the range carry a non-empty escape trailer?
 * @param {string[]} lines commit-message lines from the PR range
 */
export function escapeDeclared(lines) {
  return lines.some((line) => TRAILER.test(line.trim()));
}

/**
 * Evaluate a change set. Pure — no git access — so it stays testable.
 * @param {{status: string, path: string}[]} changes parsed name-status entries
 * @param {string[]} messageLines commit-message lines from the PR range
 * @returns {{pass: boolean, reason: string, sourceFiles: string[]}}
 */
export function evaluate(changes, messageLines = []) {
  const sourceFiles = changes.filter((c) => isSource(c.path)).map((c) => c.path);
  const hasCoverage = changes.some((c) => isCoverage(c.path));

  if (sourceFiles.length === 0) {
    return { pass: true, reason: "no-source-change", sourceFiles };
  }
  if (hasCoverage) {
    return { pass: true, reason: "coverage-present", sourceFiles };
  }
  if (escapeDeclared(messageLines)) {
    return { pass: true, reason: "escape-declared", sourceFiles };
  }
  return { pass: false, reason: "missing-coverage", sourceFiles };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

/** Resolve the base ref: the argument, else GITHUB_BASE_REF, trying origin/. */
function resolveBase() {
  const candidate = process.argv[2] || process.env.GITHUB_BASE_REF || "";
  if (!candidate) return null;
  for (const ref of [candidate, `origin/${candidate}`]) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

/** Parse `git diff --name-status base...HEAD` (merge-base diff). */
function readChanges(base) {
  const out = git(["diff", "--name-status", `${base}...HEAD`]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      // Renames (Rxxx) print old<TAB>new — the new path is the one that exists.
      return { status: status[0], path: rest[rest.length - 1] };
    });
}

function main() {
  const base = resolveBase();
  if (!base) {
    console.log("check-test-presence: no resolvable base ref (branch push or local run) — skipped.");
    return 0;
  }

  const changes = readChanges(base);
  const messageLines = git(["log", `${base}..HEAD`, "--format=%B"]).split("\n");
  const result = evaluate(changes, messageLines);

  if (result.pass) {
    const detail = {
      "no-source-change": "no runner source changed",
      "coverage-present": `${result.sourceFiles.length} source file(s) changed, with a matching test change`,
      "escape-declared":
        "source changed with no test, but a Refactor-only:/Test-plan: trailer declares why — reviewers hold you to it",
    }[result.reason];
    console.log(`check-test-presence: pass (base ${base}) — ${detail}.`);
    return 0;
  }

  console.log(`check-test-presence: FAIL (base ${base}). Source files with no matching test change:`);
  for (const file of result.sourceFiles) {
    console.log(`  - ${file}`);
  }
  console.log("");
  console.error(
    "::error title=Test-presence gate::Runner source changed but no test changed. " +
      "Add a Playwright spec (runner/e2e/*.spec.ts) for anything a user can see or do, " +
      "or a node --test unit (runner/pipeline/*.test.mjs) for pure logic and worker routes. " +
      "Pure refactor with no behavior change? Put `Refactor-only: <reason>` on a commit in this PR. " +
      "Tests landing elsewhere? Declare it with `Test-plan: <reason>`. " +
      "The decision rules live in runner/docs/TESTING.md.",
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main());
}
