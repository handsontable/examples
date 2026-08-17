// Headless demo creation over the MCP service path (DEV-2501, ADR-0033).
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  MAX_MCP_BYTES,
  MAX_MCP_FILES,
  isMcpCreated,
  isMcpValidationError,
  isTeamEmail,
  validateMcpFiles,
} from "../workers/api/src/mcp-create.ts";
import { authenticateService, normalizeEmail, sameOwner } from "../workers/api/src/auth.ts";
import { demoListQuery } from "../workers/api/src/demos-list.ts";

const ok = { "/package.json": '{"name":"demo"}', "/index.js": "console.log(1)" };

test("a valid agent-supplied file map passes through unchanged", () => {
  const result = validateMcpFiles(ok);
  assert.deepEqual(result, ok);
});

test("a manifest is required — otherwise the build fails inside a container instead of here", () => {
  assert.ok(isMcpValidationError(validateMcpFiles({ "/index.js": "x" })));
});

test("shapes that are not a path->text map are refused", () => {
  for (const bad of [null, undefined, [], "files", 42, {}]) {
    assert.ok(isMcpValidationError(validateMcpFiles(bad)), JSON.stringify(bad ?? null));
  }
  assert.ok(isMcpValidationError(validateMcpFiles({ "/package.json": 42 })));
  assert.ok(isMcpValidationError(validateMcpFiles({ "package.json": "{}" })), "relative path");
  assert.ok(isMcpValidationError(validateMcpFiles({ "/../etc/passwd": "x" })), "traversal");
});

test("env files are refused wherever they sit — a demo is one save from a public link", () => {
  // `.envrc` included: direnv puts secrets there, and a pattern matching only `.env` and
  // `.env.<suffix>` let it through (security review of PR #170).
  for (const path of [
    "/.env",
    "/.env.local",
    "/app/.env",
    "/config/.env.production",
    "/.envrc",
    "/app/.envrc",
    "/.env.staging.local",
  ]) {
    const result = validateMcpFiles({ "/package.json": "{}", [path]: "SECRET=1" });
    assert.ok(isMcpValidationError(result), path);
  }
});

test("build output, vendor dirs and lockfiles are refused rather than filtered", () => {
  // Silently dropping them would build something the caller did not write.
  for (const path of [
    "/node_modules/handsontable/index.js",
    "/dist/bundle.js",
    "/.git/config",
    "/package-lock.json",
    "/pnpm-lock.yaml",
  ]) {
    assert.ok(isMcpValidationError(validateMcpFiles({ "/package.json": "{}", [path]: "x" })), path);
  }
});

test("the file count and byte caps both hold", () => {
  const many = { "/package.json": "{}" };
  for (let i = 0; i < MAX_MCP_FILES; i++) many[`/f${i}.js`] = "x";
  assert.ok(isMcpValidationError(validateMcpFiles(many)));

  const big = { "/package.json": "{}", "/big.js": "x".repeat(MAX_MCP_BYTES + 1) };
  assert.ok(isMcpValidationError(validateMcpFiles(big)));
});

test("only @handsontable.com addresses can own an MCP-created demo", () => {
  assert.ok(isTeamEmail("dev@handsontable.com"));
  assert.ok(isTeamEmail("  Dev@Handsontable.com "));
  for (const bad of ["dev@handsontable.com.evil.io", "dev@example.com", "", null, undefined, 42]) {
    assert.ok(!isTeamEmail(bad), JSON.stringify(bad ?? null));
  }
});

// --- service auth -----------------------------------------------------------

const req = (headers) => new Request("https://demos.handsontable.com/api/mcp/demos", { headers });

test("the service path is closed when no secret is configured", async () => {
  const identity = await authenticateService(
    req({ "X-MCP-Secret": "anything", "X-Demo-Author": "dev@handsontable.com" }),
    {},
  );
  assert.equal(identity, null);
});

test("a correct secret plus a team author authenticates as that author", async () => {
  const identity = await authenticateService(
    req({ "X-MCP-Secret": "s3cret", "X-Demo-Author": "Dev@Handsontable.com" }),
    { MCP_SHARED_SECRET: "s3cret" },
  );
  assert.deepEqual(identity, { email: "dev@handsontable.com" });
});

test("a wrong secret, a missing author, or a non-team author are all refused", async () => {
  const env = { MCP_SHARED_SECRET: "s3cret" };
  const cases = [
    { "X-MCP-Secret": "wrong", "X-Demo-Author": "dev@handsontable.com" },
    { "X-MCP-Secret": "s3cre", "X-Demo-Author": "dev@handsontable.com" }, // shorter
    { "X-MCP-Secret": "s3cret" }, // no author
    { "X-MCP-Secret": "s3cret", "X-Demo-Author": "outsider@example.com" },
    { "X-Demo-Author": "dev@handsontable.com" }, // no secret presented
  ];
  for (const headers of cases) {
    assert.equal(await authenticateService(req(headers), env), null, JSON.stringify(headers));
  }
});

// --- ownership is case-insensitive (Bugbot, PR #170) ---------------------------
//
// The service path normalises the asserted author; the broker path did not normalise
// what it read. `created_by` is compared as a string, so a mixed-case address meant an
// MCP-created demo could miss its owner's My demos and 403 their own edit.

test("the service path asserts one normalised form of an address", async () => {
  const service = await authenticateService(
    req({ "X-MCP-Secret": "s", "X-Demo-Author": " Dev@Handsontable.COM " }),
    { MCP_SHARED_SECRET: "s" },
  );
  assert.equal(service.email, "dev@handsontable.com");
  assert.equal(normalizeEmail(" Dev@Handsontable.COM "), "dev@handsontable.com");
});

test("ownership folds case, so rows written before normalisation still match", () => {
  assert.ok(sameOwner("Dev@Handsontable.com", "dev@handsontable.com"));
  assert.ok(sameOwner("dev@handsontable.com", " DEV@handsontable.com "));
  assert.ok(!sameOwner("someone@handsontable.com", "dev@handsontable.com"));
  // An empty owner must never match an empty identity into ownership of a row.
  assert.ok(!sameOwner("", ""));
  assert.ok(!sameOwner(undefined, undefined));
  assert.ok(!sameOwner(null, "dev@handsontable.com"));
});

test("the listing query matches an owner regardless of the stored case", () => {
  const { sql, binds } = demoListQuery("mine", " Dev@Handsontable.com ");
  assert.match(sql, /LOWER\(created_by\) = \?/);
  assert.deepEqual(binds, ["dev@handsontable.com"]);
});

// --- updating a demo from the MCP (DEV-2501) ----------------------------------
//
// The update path re-uses validateMcpFiles, so the file rules are already covered
// above. What is specific to it is *who* may rewrite *which* demo: the shared secret
// says a trusted service is calling, never whose demos it may touch. That check is
// `sameOwner(row.created_by, assertedAuthor)` in the route; these cases pin the
// comparison it depends on.

test("only the demo's own author may update it", () => {
  const row = { created_by: "dev@handsontable.com" };
  assert.ok(sameOwner(row.created_by, "dev@handsontable.com"));
  // Case is folded, so a mixed-case session still owns its own demo.
  assert.ok(sameOwner(row.created_by, "Dev@Handsontable.com"));
  // Somebody else's demo is refused even with a valid service secret.
  assert.ok(!sameOwner(row.created_by, "someone.else@handsontable.com"));
  // A row with no author is nobody's — it must never become updatable.
  assert.ok(!sameOwner("", "dev@handsontable.com"));
  assert.ok(!sameOwner(undefined, "dev@handsontable.com"));
});

test("an update payload is held to the same file rules as a create", () => {
  // The route calls validateMcpFiles on `patch.files`, so a fixed demo cannot
  // smuggle in what a new one could not.
  assert.ok(isMcpValidationError(validateMcpFiles({ "/package.json": "{}", "/.envrc": "S=1" })));
  assert.ok(isMcpValidationError(validateMcpFiles({ "/index.js": "x" })), "manifest still required");
  assert.deepEqual(validateMcpFiles(ok), ok);
});

test("only demos the MCP created are updatable through it", () => {
  // Containment for the shared-secret trust model (security review of PR #177): the
  // asserted author cannot be stronger than the secret that carries it, so the path is
  // limited to what this service published. `forked_from` is the provenance stamp.
  //
  // `isMcpCreated` is the production predicate — imported, not re-declared here. An
  // earlier version of this test asserted against its own local copy, which stayed
  // green with the route guard deleted; a test of a security control has to be able
  // to fail when the control goes away.
  assert.ok(isMcpCreated({ forked_from: "mcp:javascript" }));
  assert.ok(isMcpCreated({ forked_from: "mcp:react" }));
  // Anything built in the browser stays out of reach of this route.
  assert.ok(!isMcpCreated({ forked_from: "catalog:javascript" }));
  assert.ok(!isMcpCreated({ forked_from: null }));
  assert.ok(!isMcpCreated({ forked_from: undefined }));
  assert.ok(!isMcpCreated({}));
});

test("the update route calls isMcpCreated(), not a re-inlined copy of it", () => {
  // Same style as pipeline/theme-codegen.test.mjs: the rule is structural, so the
  // route source is read as text. Importing the predicate (above) proves what it
  // decides; this proves the route still *asks* it — an inline `forked_from` check
  // could drift away from the exported one while every import-based test stays green.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(join(root, "workers/api/src/index.ts"), "utf8");
  const start = source.indexOf('request.method === "PATCH" && parts[0] === "api" && parts[1] === "mcp"');
  assert.ok(start > -1, "the MCP update route exists in index.ts");
  const end = source.indexOf('parts[1] === "demos"', start);
  const route = source.slice(start, end > -1 ? end : undefined);
  assert.match(route, /isMcpCreated\(/, "the route must gate on the exported predicate");
  assert.doesNotMatch(
    route,
    /forked_from\?*\.\s*startsWith/,
    "an inline forked_from check would no longer be what the tests import — call isMcpCreated()",
  );
});
