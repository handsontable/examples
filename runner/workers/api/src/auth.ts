// Internal-team auth via the Handsontable Google login broker (ADR-0007).
// Write endpoints require a broker JWT; we re-validate it server-side and trust
// only the returned email. No service account, no app-wide credential.

import type { Env } from "./env.js";

export interface Identity {
  email: string;
  sub?: string;
}

/**
 * Validate the caller's broker token and return their identity, or null.
 * Local dev bypass: if DEV_AUTH_EMAIL is set (via .dev.vars), trust it — never
 * set this in production.
 */
export async function authenticate(request: Request, env: Env): Promise<Identity | null> {
  const devEmail = (env as { DEV_AUTH_EMAIL?: string }).DEV_AUTH_EMAIL;
  if (devEmail) return { email: devEmail };

  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  try {
    const res = await fetch(`${env.LOGIN_BROKER_URL}/broker/userinfo`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) return null;
    // Email and `sub` are all there is: the broker's authorize redirect asks for
    // `scope=openid email`, so no `name` or `picture` claim exists to read. Display
    // names come from the address's own `name.surname` shape instead — ADR-0007.
    const info = (await res.json()) as { email?: string; sub?: string };
    if (!info.email || !info.email.endsWith("@handsontable.com")) return null;
    return { email: info.email, sub: info.sub };
  } catch {
    return null;
  }
}
