// ADR §B.5 `deploy` row: "GitHub OIDC token (issuer, audience, repository,
// workflow), secret fallback". Verifies a GitHub Actions OIDC id-token
// (`Authorization: Bearer <token>`) against GitHub's own JWKS with `jose`.
//
// T02-D — the audience string (see the task Outcome): the contract does not
// pin one. `O11Y_GITHUB_OIDC_AUDIENCE` below is this task's choice —
// "identify the intended recipient," GitHub's own recommendation — and
// whichever CI workflow requests the id-token (T10, `master.yml`'s deploy
// job per the observability contract §2 "each deploy job posts …") must
// request it with this exact `audience` query parameter or every deploy
// event falls through to the secret fallback instead of the OIDC path.
//
// T02-D16 (fix round — the first pass checked only issuer, audience and
// repository, missing ADR §B.5's fourth check, "workflow"): GitHub Actions
// stamps every OIDC token with a `workflow_ref` claim,
// `<owner>/<repo>/<workflow file path>@<ref>` — for a workflow that runs
// directly (not called via `workflow_call`), this is the same value as
// `job_workflow_ref`; the deploy job is expected to run directly, so
// `workflow_ref` is what this checks. Exact match against
// `env.GITHUB_OIDC_WORKFLOW_REF`, whose expected value (documented on the
// `Env` field and in `wrangler.jsonc`) is
// `handsontable/examples/.github/workflows/master.yml@refs/heads/master` —
// **T10 must keep this in sync** with the real deploy workflow's file path
// and the ref it runs from.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env.js";
import { checkExportSecret } from "./secret.js";
import { type GateResult, drop, ok } from "./types.js";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const O11Y_GITHUB_OIDC_AUDIENCE = "https://demos.handsontable.com/telemetry/deploy";

// One JWKS fetcher per isolate, not per request — `jose`'s remote set caches
// the keys itself; this map just avoids rebuilding the fetcher function.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function githubJwks(): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(GITHUB_OIDC_ISSUER);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));
    jwksCache.set(GITHUB_OIDC_ISSUER, jwks);
  }
  return jwks;
}

/** Test-only: clears the per-isolate cache above. `jose`'s remote key set has
 *  its own internal no-refetch cooldown (~30 s) on a `kid` miss — real
 *  production traffic never hits it (one real issuer, one real, slowly
 *  rotating JWKS), but a test file that signs a *different* RSA key pair per
 *  test case would otherwise have every test after the first reuse the
 *  first test's cached (and now wrong) key set, fail JWT verification for an
 *  unrelated reason, and still assert `ok: false` — passing for the wrong
 *  reason. Found exactly this way: reverting the T02-D16 workflow check kept
 *  its test green until this reset was added and called per test. */
export function _resetGithubJwksCacheForTests(): void {
  jwksCache.clear();
}

/** Verifies the bearer token's issuer, audience and `repository` claim
 *  against `env.GITHUB_OIDC_REPOSITORY`. Returns `null` (not a drop) when no
 *  bearer token is present at all, so the caller can fall through to
 *  {@link checkDeployGate}'s secret fallback — an actually-malformed or
 *  wrong-repository token, by contrast, is a hard `401`, since a caller that
 *  sent *a* token and got it wrong should not silently succeed via the
 *  fallback path instead. */
async function checkGithubOidc(req: Request, env: Env): Promise<GateResult | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length);

  try {
    const { payload } = await jwtVerify(token, githubJwks(), {
      issuer: GITHUB_OIDC_ISSUER,
      audience: O11Y_GITHUB_OIDC_AUDIENCE,
    });
    if (payload["repository"] !== env.GITHUB_OIDC_REPOSITORY) {
      return drop("oidc", 401, "repository mismatch");
    }
    if (payload["workflow_ref"] !== env.GITHUB_OIDC_WORKFLOW_REF) {
      return drop("oidc", 401, "workflow mismatch");
    }
    return ok();
  } catch (err) {
    return drop("oidc", 401, err instanceof Error ? err.message : String(err));
  }
}

/** `deploy` route gate: GitHub OIDC first, `x-o11y-secret` fallback (ADR
 *  §B.5). A present-but-invalid OIDC token is a hard `401` (see above); only
 *  a genuinely absent bearer token falls through to the secret. */
export async function checkDeployGate(req: Request, env: Env): Promise<GateResult> {
  const oidc = await checkGithubOidc(req, env);
  if (oidc) return oidc;
  return checkExportSecret(req, env);
}
