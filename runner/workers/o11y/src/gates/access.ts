// COMMON.md pinned interface 3: `verifyAccess(req, env)`, exported for T03's
// `/grafana/*` and `/grafana/_o11y/reopen` routes. ADR §B.5 `/grafana/*`,
// `reopen` row: `Cf-Access-Jwt-Assertion` verified against the Access JWKS in
// the Worker; a client-sent `auth.proxy` header is stripped (T01/T03's job at
// the point they build the proxied request onward — this file only verifies).

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../env.js";

export interface AccessIdentity {
  email: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function accessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Verifies `Cf-Access-Jwt-Assertion` against the team's Access JWKS and
 * `env.ACCESS_AUD`, returning the authenticated email or `null`.
 *
 * `DEV_ADMIN` is honoured **only** when `O11Y_ENV === "local"` (fail-closed —
 * the same rule `env.ts` documents on the field itself): a production
 * deploy's `O11Y_ENV` is always `"production"` from `wrangler.jsonc`'s `vars`
 * block, so `DEV_ADMIN` being accidentally set as a *secret* in production
 * (it should never be — it belongs in `.dev.vars` only, which is never
 * deployed) still could not bypass Access, because the environment check
 * comes first.
 *
 * `ACCESS_AUD` is a placeholder (`""`) until T03 creates the real Access
 * application (T00-D8) — an empty audience must never be handed to `jose`
 * (an empty string technically matches "no audience restriction" in some
 * JWT libraries; explicitly refusing it here means a not-yet-configured
 * Access application fails closed instead of accidentally accepting any
 * token whose issuer matches).
 */
export async function verifyAccess(req: Request, env: Env): Promise<AccessIdentity | null> {
  if (env.O11Y_ENV === "local" && env.DEV_ADMIN) {
    return { email: env.DEV_ADMIN };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, accessJwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    const email = payload["email"];
    return typeof email === "string" && email.length > 0 ? { email } : null;
  } catch {
    return null;
  }
}
