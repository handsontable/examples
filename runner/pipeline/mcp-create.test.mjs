// Headless demo creation over the MCP service path (DEV-2501, ADR-0033).
//
// The imports are dynamic, behind the `.js`->`.ts` module hooks, because
// `auth.ts` stopped being an import-free leaf when the persistent-token path
// landed (DEV-2583): it now pulls in `token.js` / `token-store.js` by the
// repo's NodeNext-style specifier, which bare `--experimental-strip-types`
// cannot resolve. Nothing here drives the token path — `authenticateService` is
// the subject — but the module graph has to load all the same.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { register } from "node:module";

register("./fixtures/worker-hooks.mjs", import.meta.url);

const {
  MAX_MCP_BYTES,
  MAX_MCP_FILES,
  isMcpCreated,
  isMcpValidationError,
  isTeamEmail,
  validateMcpFiles,
  validateBuildToolchain,
  validateHtmlEntry,
} = await import("../workers/api/src/mcp-create.ts");
const { authenticateService, normalizeEmail, sameOwner } = await import("../workers/api/src/auth.ts");
const { demoListQuery } = await import("../workers/api/src/demos-list.ts");
const { BUILD_CONFIG } = await import("../workers/api/src/frameworks.generated.ts");
const { snapshotBuildCommand } = await import("../workers/api/src/build-command.ts");

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
  // The code shape, not the name: the route's own comment also says
  // "isMcpCreated()" in prose, so a bare name-match would stay green with the
  // guard deleted and the comment left behind (Bugbot, #201).
  assert.match(route, /!isMcpCreated\(row\)/, "the route must gate on the exported predicate");
  assert.doesNotMatch(
    route,
    /forked_from\?*\.\s*startsWith/,
    "an inline forked_from check would no longer be what the tests import — call isMcpCreated()",
  );
});

// --- the build-toolchain gate (Sentry DEMOS-31) --------------------------------
//
// The build command comes from the catalog, not the payload, so a manifest
// that omits the framework's build tool installs cleanly (pnpm exits 0 on the
// non-frozen retry — lockfiles are always refused on this path) and then dies
// as `sh: 1: vite: not found` after a container boot billed against the spend
// ceiling. Decided from the request alone, so a refusal here costs nothing.

test("a manifest declaring the build tool passes, in either dependency section", () => {
  assert.equal(
    validateBuildToolchain({ "/package.json": JSON.stringify({ dependencies: { vite: "^5.4.0" } }) }, "vite build"),
    null,
  );
  assert.equal(
    validateBuildToolchain(
      { "/package.json": JSON.stringify({ devDependencies: { vite: "^5.4.0" } }) },
      "vite build",
    ),
    null,
  );
});

test("a peerDependencies-only declaration satisfies the check — pnpm auto-installs peers in the builder image", () => {
  // The builder runs pnpm 10.34.5 with auto-install-peers on by default and no
  // .npmrc overriding it, so the non-frozen retry this path always takes
  // (lockfiles are refused) installs a peer-only declaration into
  // node_modules/.bin just like a dependencies one. Refusing this would be a
  // false rejection of a demo that builds fine in the real container.
  const result = validateBuildToolchain(
    { "/package.json": JSON.stringify({ peerDependencies: { vite: "^5.4.0" } }) },
    "vite build",
  );
  assert.equal(result, null);
});

test("an unparseable manifest is refused here, not inside a container", () => {
  const result = validateBuildToolchain({ "/package.json": "{" }, "vite build");
  assert.ok(isMcpValidationError(result));
  assert.match(result.error, /package\.json/);
});

test("an unmapped build binary is never a refusal", () => {
  // The table can fall behind the catalog; when it does, the coverage test
  // below is what fails, never a caller in production.
  assert.equal(
    validateBuildToolchain({ "/package.json": JSON.stringify({ dependencies: {} }) }, "somethingnew build"),
    null,
  );
});

test("BUILD_TOOL_PACKAGE covers every framework in BUILD_CONFIG", () => {
  for (const [framework, entry] of Object.entries(BUILD_CONFIG)) {
    const bin = snapshotBuildCommand(entry.buildCommand).trim().split(/\s+/)[0];
    const result = validateBuildToolchain(
      { "/package.json": JSON.stringify({ dependencies: {} }) },
      entry.buildCommand,
    );
    assert.ok(
      isMcpValidationError(result),
      `BUILD_TOOL_PACKAGE has no entry for "${bin}" (framework "${framework}"), so an empty manifest was not refused`,
    );
  }
});

// DEV-2741. The other way an agent payload builds into nothing: an HTML entry that
// loads no module. Measured in production on `/share/6n1lu5k2s3` — the demo's
// `/index.html` was `<div id="grid" ...></div>` and nothing else, so the Tier-1
// bundler (whose entry *is* that document) and `vite build` both had no module to run,
// and the page came out as an empty div on every surface with no error anywhere.

const JS_CFG = BUILD_CONFIG["javascript"];

test("BUILD_CONFIG carries the two entry paths the HTML gate needs", () => {
  // Generated from catalog.json by scripts/prepare-container.mjs; without them the
  // gate below silently passes everything.
  assert.equal(JS_CFG.entry, "/index.js");
  assert.equal(JS_CFG.htmlEntry, "/index.html");
  for (const [framework, cfg] of Object.entries(BUILD_CONFIG)) {
    assert.equal(typeof cfg.entry, "string", `${framework} has no entry`);
    assert.ok(cfg.htmlEntry === null || typeof cfg.htmlEntry === "string", framework);
  }
});

test("the reported shape — an index.html with no script — is refused", () => {
  const result = validateHtmlEntry(
    { "/package.json": "{}", "/index.js": "x", "/index.html": '<div id="grid"></div>\n' },
    JS_CFG,
  );
  assert.ok(isMcpValidationError(result));
  // The message has to carry the fix: the caller is a model, and "invalid" teaches it
  // nothing it can act on.
  assert.match(result.error, /<script type="module" src="\/index\.js"><\/script>/);
});

test("a document that loads its entry passes", () => {
  const result = validateHtmlEntry(
    {
      "/package.json": "{}",
      "/index.js": "x",
      "/index.html": '<body><div id="grid"></div><script type="module" src="/index.js"></script></body>',
    },
    JS_CFG,
  );
  assert.equal(result, null);
});

test("a document loading a module other than the catalog entry is not a refusal", () => {
  // It builds and renders on both paths; refusing it would be a false rejection.
  const result = validateHtmlEntry(
    {
      "/package.json": "{}",
      "/src/main.js": "x",
      "/index.html": '<script type="module" src="/src/main.js"></script>',
    },
    JS_CFG,
  );
  assert.equal(result, null);
});

test("a script pointing at a file that was never sent is refused, naming the file", () => {
  const result = validateHtmlEntry(
    { "/package.json": "{}", "/index.js": "x", "/index.html": '<script src="/main.js"></script>' },
    JS_CFG,
  );
  assert.ok(isMcpValidationError(result));
  assert.match(result.error, /\/main\.js/);
});

test("a missing HTML entry is refused by name", () => {
  const result = validateHtmlEntry({ "/package.json": "{}", "/index.js": "x" }, JS_CFG);
  assert.ok(isMcpValidationError(result));
  assert.match(result.error, /\/index\.html/);
});

test("a framework with no HTML entry is out of scope for the gate", () => {
  assert.equal(validateHtmlEntry({ "/package.json": "{}" }, { entry: "/x.js", htmlEntry: null }), null);
});

test("an inline or CDN script is left alone", () => {
  for (const html of ['<script>boot()</script>', '<script src="https://cdn.example/x.js"></script>']) {
    assert.equal(
      validateHtmlEntry({ "/package.json": "{}", "/index.js": "x", "/index.html": html }, JS_CFG),
      null,
      html,
    );
  }
});
