import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// T10 — the runbook drift gate (task acceptance criterion: "every secret and
// var declared in workers/o11y/src/env.ts appears in the runbook; a renamed
// binding fails the test"). Parses `workers/o11y/src/env.ts`'s `Env`
// interface from disk — never a hand-copied list — so editing either side
// alone (renaming a field, or dropping its runbook line) fails this file,
// the same "contract" pattern `pipeline/telemetry-contract.test.mjs` and
// `pipeline/api-telemetry-config.test.mjs` already use for their own sources
// of truth.
//
// Scope: only the *configuration surface* — fields typed as a plain string
// (optionally optional, optionally a string-literal union) — not the
// resource bindings (`DurableObjectNamespace<...>`, `R2Bucket`,
// `AnalyticsEngineDataset`, `Fetcher`, `RateLimit`). A binding is provisioned
// through `wrangler.jsonc`/`docs/cloudflare-resources.md`, not a value an
// operator types into a `wrangler secret put`/`--var` command, and including
// `API` (typed `Fetcher`) would make the check pass vacuously — that word
// appears everywhere in prose that has nothing to do with the binding.
//
// Match as a backtick-wrapped markdown token (`` `NAME` ``), not a bare
// substring — `ACCESS_AUD` must name the var, not just share a prefix with
// running prose that happens to contain it.

const envTsPath = fileURLToPath(new URL("../workers/o11y/src/env.ts", import.meta.url));
const runbookPath = fileURLToPath(new URL("../docs/run-and-deploy.md", import.meta.url));

const envTs = fs.readFileSync(envTsPath, "utf8");
const runbook = fs.readFileSync(runbookPath, "utf8");

/** The `export interface Env { ... }` block, brace-matched (not a fixed-line
 *  slice) so it stays correct as the interface grows. */
function extractEnvInterface(source) {
  const start = source.indexOf("export interface Env {");
  assert.notEqual(start, -1, "workers/o11y/src/env.ts: `export interface Env {` not found");
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error("unbalanced braces in the Env interface");
}

/** Strips `/** ... *\/` block comments and `//` line comments so a name
 *  mentioned only in prose (e.g. this file's own header, or a doc comment
 *  cross-referencing another field) is never mistaken for a field
 *  declaration. */
function stripComments(text) {
  return text.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** One field declaration per line, `NAME` or `NAME?`, followed by `:` and a
 *  type. Only plain-string-ish types are configuration surface (see header):
 *  `string`, `string?`, or a quoted string-literal union like
 *  `"production" | "local"`. Everything else (DurableObjectNamespace<...>,
 *  R2Bucket, AnalyticsEngineDataset, Fetcher, RateLimit, and the
 *  `InboxWriterApi` methods living in the same file but outside this
 *  interface) is a resource binding, out of this test's scope. */
function configFieldNames(interfaceBody) {
  const body = stripComments(interfaceBody);
  const names = [];
  const fieldRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??:\s*([^;]+);/gm;
  let m;
  while ((m = fieldRe.exec(body))) {
    const [, name, rawType] = m;
    const type = rawType.trim();
    const isPlainString = type === "string";
    const isStringLiteralUnion = /^"[^"]*"(\s*\|\s*"[^"]*")*$/.test(type);
    if (isPlainString || isStringLiteralUnion) names.push(name);
  }
  return names;
}

const envInterfaceBody = extractEnvInterface(envTs);
const configNames = configFieldNames(envInterfaceBody);

test("env.ts's Env interface still has a configuration surface to check", () => {
  // A broken interface-slice or field regex must not silently pass on an
  // empty set — pin a floor well under the current real count (19 at the
  // time this test was written, K1: O11Y_ENV, LOGIN_BROKER_URL,
  // GITHUB_OIDC_REPOSITORY, GITHUB_OIDC_WORKFLOW_REF, SERVICE_VERSION,
  // CLOUDFLARE_ACCOUNT_ID, LOKI_S3_BUCKET, RUNNER_EVENTS_CLICKHOUSE_URL,
  // O11Y_LOCAL_MINIO_PORT, O11Y_LOCAL_CLICKHOUSE_PORT,
  // O11Y_LOCAL_PUBLIC_ORIGIN, O11Y_EXPORT_SECRET, SENTRY_HOOK_SECRET,
  // AE_SQL_TOKEN, LOKI_S3_ACCESS_KEY_ID, LOKI_S3_SECRET_ACCESS_KEY,
  // SLACK_WEBHOOK_URL, O11Y_SESSION_SECRET, DEV_ADMIN).
  assert.ok(
    configNames.length >= 15,
    `expected at least 15 config fields in Env, found ${configNames.length}: ${configNames.join(", ")}`,
  );
  // Sanity: a resource binding must NOT have been picked up (proves the
  // type filter, not just the field regex, is doing real work).
  assert.ok(!configNames.includes("API"), "API is a Fetcher binding, not configuration surface");
  assert.ok(!configNames.includes("INBOX_WRITER"), "INBOX_WRITER is a Durable Object binding");
  assert.ok(!configNames.includes("RUNNER_EVENTS"), "RUNNER_EVENTS is an Analytics Engine binding");
});

test("every o11y config name in env.ts is documented in run-and-deploy.md", () => {
  const missing = configNames.filter((name) => !runbook.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `not documented as a backtick-wrapped name in docs/run-and-deploy.md: ${missing.join(", ")}`);
});

// Fix round (review finding I1): the source-map upload authenticates with a
// dedicated R2 S3 credential, scoped to the maps bucket only, instead of the
// account-wide CLOUDFLARE_API_TOKEN. Those two secret names live in
// master.yml's `secrets.*` context and GitHub's own repo-secrets store —
// never in workers/o11y/src/env.ts, since the o11y Worker itself never reads
// them (only the CI job's `aws s3 cp` step does). `configFieldNames` above
// therefore cannot see them, so they need their own small, explicit list
// here rather than falling out of the Env-interface parse — the same
// "a renamed/dropped name must fail this test" guarantee, extended to the
// one pair of secrets that sits outside the Worker's own config surface.
const CI_ONLY_SECRET_NAMES = ["R2_MAPS_ACCESS_KEY_ID", "R2_MAPS_SECRET_ACCESS_KEY"];

test("the CI-only R2 maps-upload secrets are documented in run-and-deploy.md", () => {
  const missing = CI_ONLY_SECRET_NAMES.filter((name) => !runbook.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `not documented as a backtick-wrapped name in docs/run-and-deploy.md: ${missing.join(", ")}`);
});

test("configFieldNames ignores resource-binding types and comment-only mentions", () => {
  const fixture = `
    // secrets and vars
    O11Y_ENV: "production" | "local";
    ACCESS_AUD: string;
    /** mentions API_EXAMPLE in a doc comment only, not a field */
    OPTIONAL_ONE?: string;
    API: Fetcher;
    INBOX_WRITER: DurableObjectNamespace<InboxWriter>;
    RUNNER_EVENTS: AnalyticsEngineDataset;
    RATE_LIMITER: RateLimit;
  `;
  const names = configFieldNames(fixture);
  assert.deepEqual(names.sort(), ["ACCESS_AUD", "O11Y_ENV", "OPTIONAL_ONE"].sort());
});
