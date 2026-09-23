// ADR §B.5 gate tests — one per row, run against the real gate functions
// under plain `node --test` via `o11y-worker-hooks.mjs` (`.js`→`.ts` remap,
// `cloudflare:workers`/`@cloudflare/containers` stubs). Each gate is tested
// for both directions: it must reject the bad input and accept the good one
// — "Each gate test fails when its gate is bypassed" (task acceptance
// criteria) means the accept-side assertion has nothing else standing
// between it and a pass, so disabling the gate's own check (not just this
// test) is exactly what turns the reject-side case red.
//
// Run: node --experimental-strip-types --test pipeline/o11y-gates.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

// `jose` must be a *dynamic* import too, like every worker-tree import below
// — a static `import … from "jose"` at the top of this file resolves during
// module-graph linking, before `register()`'s hook has taken effect (the
// same reason `mcp-routes.test.mjs` keeps every worker import dynamic).
const { SignJWT, exportJWK, generateKeyPair } = await import("jose");

const { checkBrowserGates, checkPayloadEnvironment } = await import("../workers/o11y/src/gates/browser.ts");
const { checkExportSecret } = await import("../workers/o11y/src/gates/secret.ts");
const { checkSentryHmac } = await import("../workers/o11y/src/gates/sentry.ts");
const { checkDeployGate, O11Y_GITHUB_OIDC_AUDIENCE } = await import("../workers/o11y/src/gates/oidc.ts");
const { verifyAccess } = await import("../workers/o11y/src/gates/access.ts");
const { hmacSha256Hex } = await import("../workers/o11y/src/gates/util.ts");

function baseEnv(overrides = {}) {
  return {
    O11Y_ENV: "production",
    ACCESS_TEAM_DOMAIN: "handsontable.cloudflareaccess.com",
    ACCESS_AUD: "test-aud",
    GITHUB_OIDC_REPOSITORY: "handsontable/examples",
    O11Y_EXPORT_SECRET: "top-secret",
    SENTRY_HOOK_SECRET: "sentry-secret",
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  };
}

// ---- browser.ts: host/env, bot, size, rate limit -------------------------------

test("browser gate: production Origin passes, an unrelated Origin is a host drop", async () => {
  const env = baseEnv();
  const ok = await checkBrowserGates(
    new Request("https://demos.handsontable.com/telemetry/collect", {
      method: "POST",
      headers: { Origin: "https://demos.handsontable.com" },
    }),
    env,
    1_000_000,
  );
  assert.equal(ok.ok, true);

  const bad = await checkBrowserGates(
    new Request("https://demos.handsontable.com/telemetry/collect", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
    }),
    env,
    1_000_000,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "host");
});

test("browser gate: localhost passes only when O11Y_ENV is local", async () => {
  const localReq = () =>
    new Request("https://demos.handsontable.com/telemetry/collect", {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });

  const local = await checkBrowserGates(localReq(), baseEnv({ O11Y_ENV: "local" }), 1_000_000);
  assert.equal(local.ok, true);

  const prod = await checkBrowserGates(localReq(), baseEnv({ O11Y_ENV: "production" }), 1_000_000);
  assert.equal(prod.ok, false);
  assert.equal(prod.reason, "host");
});

test("browser gate: a BOT_RE user-agent is dropped with reason bot", async () => {
  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com", "user-agent": "curl/8.0.0" },
  });
  const result = await checkBrowserGates(req, baseEnv(), 1_000_000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bot");
});

test("browser gate: an oversized Content-Length is dropped with reason size", async () => {
  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com", "content-length": "999999999" },
  });
  const result = await checkBrowserGates(req, baseEnv(), 1_000_000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "size");
});

test("browser gate: a denied rate limiter drops with reason rate_limit", async () => {
  const req = new Request("https://demos.handsontable.com/telemetry/collect", {
    method: "POST",
    headers: { Origin: "https://demos.handsontable.com" },
  });
  const env = baseEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const result = await checkBrowserGates(req, env, 1_000_000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rate_limit");
});

test("payload environment gate: undefined passes, a mismatched declared environment drops", () => {
  const env = baseEnv({ O11Y_ENV: "production" });
  assert.equal(checkPayloadEnvironment(undefined, env).ok, true);
  assert.equal(checkPayloadEnvironment("production", env).ok, true);
  const mismatch = checkPayloadEnvironment("local", env);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "environment");
});

// ---- secret.ts: x-o11y-secret ---------------------------------------------------

test("export secret gate: correct header passes, wrong header and missing config fail closed", () => {
  const env = baseEnv();
  const good = checkExportSecret(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", { headers: { "x-o11y-secret": "top-secret" } }),
    env,
  );
  assert.equal(good.ok, true);

  const bad = checkExportSecret(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", { headers: { "x-o11y-secret": "wrong" } }),
    env,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "secret");

  const unconfigured = checkExportSecret(
    new Request("https://demos.handsontable.com/telemetry/v1/logs", { headers: { "x-o11y-secret": "top-secret" } }),
    baseEnv({ O11Y_EXPORT_SECRET: undefined }),
  );
  assert.equal(unconfigured.ok, false, "an absent secret must fail closed, never act as a no-op gate");
});

// ---- sentry.ts: sentry-hook-signature HMAC ---------------------------------------

test("sentry HMAC gate: a correct signature passes, a wrong one fails", async () => {
  const env = baseEnv();
  const body = JSON.stringify({ action: "created" });
  const sig = await hmacSha256Hex(env.SENTRY_HOOK_SECRET, body);

  const good = await checkSentryHmac(
    new Request("https://demos.handsontable.com/telemetry/hooks/sentry", { headers: { "sentry-hook-signature": sig } }),
    env,
    body,
  );
  assert.equal(good.ok, true);

  const bad = await checkSentryHmac(
    new Request("https://demos.handsontable.com/telemetry/hooks/sentry", {
      headers: { "sentry-hook-signature": "0".repeat(64) },
    }),
    env,
    body,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "hmac");
});

// ---- oidc.ts: GitHub OIDC + secret fallback -------------------------------------

async function signGithubToken({ repository = "handsontable/examples", audience = O11Y_GITHUB_OIDC_AUDIENCE } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const token = await new SignJWT({ repository })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { token, jwks: { keys: [jwk] } };
}

test("deploy gate: a valid GitHub OIDC token for the right repository passes", async (t) => {
  const { token, jwks } = await signGithubToken();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes("token.actions.githubusercontent.com")) {
      return new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });
    }
    return realFetch(url);
  };

  const req = new Request("https://demos.handsontable.com/telemetry/deploy", {
    headers: { authorization: `Bearer ${token}` },
  });
  const result = await checkDeployGate(req, baseEnv());
  assert.equal(result.ok, true);
});

test("deploy gate: a token for the wrong repository is a hard 401, never the secret fallback", async (t) => {
  const { token, jwks } = await signGithubToken({ repository: "someone-else/other-repo" });
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });

  const req = new Request("https://demos.handsontable.com/telemetry/deploy", {
    headers: { authorization: `Bearer ${token}`, "x-o11y-secret": "top-secret" },
  });
  const result = await checkDeployGate(req, baseEnv());
  assert.equal(result.ok, false, "a wrong-repository token must not fall through to a valid secret");
  assert.equal(result.reason, "oidc");
});

test("deploy gate: no bearer token falls through to the secret fallback", async () => {
  const withSecret = await checkDeployGate(
    new Request("https://demos.handsontable.com/telemetry/deploy", { headers: { "x-o11y-secret": "top-secret" } }),
    baseEnv(),
  );
  assert.equal(withSecret.ok, true);

  const withoutSecret = await checkDeployGate(
    new Request("https://demos.handsontable.com/telemetry/deploy", {}),
    baseEnv(),
  );
  assert.equal(withoutSecret.ok, false);
});

// ---- access.ts: Cf-Access-Jwt-Assertion + DEV_ADMIN -----------------------------

test("verifyAccess: DEV_ADMIN bypasses only when O11Y_ENV is local, never in production", async () => {
  const req = new Request("https://demos.handsontable.com/grafana/");
  const local = await verifyAccess(req, baseEnv({ O11Y_ENV: "local", DEV_ADMIN: "dev@handsontable.com" }));
  assert.deepEqual(local, { email: "dev@handsontable.com" });

  const prod = await verifyAccess(req, baseEnv({ O11Y_ENV: "production", DEV_ADMIN: "dev@handsontable.com" }));
  assert.equal(prod, null, "DEV_ADMIN must never bypass Access in production");
});

test("verifyAccess: an empty ACCESS_AUD refuses rather than accepting any issuer-matching token", async () => {
  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { "Cf-Access-Jwt-Assertion": "irrelevant.token.value" },
  });
  const result = await verifyAccess(req, baseEnv({ ACCESS_AUD: "" }));
  assert.equal(result, null);
});

test("verifyAccess: a valid Access JWT returns the email claim", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "access-key";
  jwk.alg = "RS256";
  const env = baseEnv({ ACCESS_TEAM_DOMAIN: "handsontable.cloudflareaccess.com", ACCESS_AUD: "aud-123" });
  const token = await new SignJWT({ email: "artur.medrygal@handsontable.com" })
    .setProtectedHeader({ alg: "RS256", kid: "access-key" })
    .setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`)
    .setAudience(env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });

  const req = new Request("https://demos.handsontable.com/grafana/", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
  const result = await verifyAccess(req, env);
  assert.deepEqual(result, { email: "artur.medrygal@handsontable.com" });
});
