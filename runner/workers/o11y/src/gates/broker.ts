// The o11y worker's own copy of the API worker's broker-verification logic
// (`workers/api/src/auth.ts#authenticate`'s broker branch, ~15 lines).
// Deliberately duplicated rather than shared across worker trees — the
// feasibility report (§4 "Reuse from the API worker") found the reusable
// surface too small, and too different in shape, to be worth a cross-worker
// dependency: this Worker has no D1, no `hot_pat_` token store, and no
// `DEV_AUTH_EMAIL` loopback branch of its own (that bypass is `DEV_ADMIN`,
// gated in `gates/session.ts`).
//
// Called exactly once per login, from `grafana/login.ts#handleSession` —
// never per `/grafana/*` request (that would be a live Render round trip on
// every dashboard panel query, which `gates/session.ts#verifySession`
// avoids entirely by trusting the Worker's own signed cookie instead).

import type { Env } from "../env.js";

/** Mirrors `PAT_PREFIX` in `workers/api/src/token.ts` and
 *  `apps/authoring/src/auth.ts` — the three must agree, and none of them can
 *  import across worker/app boundaries. */
const PAT_PREFIX = "hot_pat_";

export interface BrokerIdentity {
  email: string;
}

/**
 * Resolves a broker token to a verified `@handsontable.com` identity, or
 * `null` on any failure (wrong shape, non-2xx, unreachable broker, a
 * non-team email). Never throws.
 *
 * Refuses anything shaped like one of OUR OWN persistent API tokens before
 * ever calling the broker — the same reasoning `workers/api/src/auth.ts`
 * gives for its own ordering: shipping our own credential to a third-party
 * host on a failed local check would be a silent downgrade from "rejected"
 * to "forwarded", and this Worker has no local token store to check it
 * against in the first place.
 */
export async function resolveBrokerIdentity(env: Env, token: string): Promise<BrokerIdentity | null> {
  if (!env.LOGIN_BROKER_URL) return null;
  if (token.startsWith(PAT_PREFIX)) return null;

  try {
    const res = await fetch(`${env.LOGIN_BROKER_URL}/broker/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const info = (await res.json()) as { email?: string };
    if (!info.email || !info.email.endsWith("@handsontable.com")) return null;
    return { email: info.email };
  } catch {
    return null;
  }
}
