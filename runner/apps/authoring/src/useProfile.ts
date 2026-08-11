// Display-only access to the signed-in user's profile (DEV-2166), for the
// surfaces that show it but never edit it: the top bar's avatar on every page,
// and the My Demos author line. The Settings page does its own thing — it needs
// in-flight and error states this hook deliberately hides.
//
// Starts from the sessionStorage cache so the avatar paints on first frame, then
// corrects itself from the network. See `profile.ts` for why the cache exists.

import { useEffect, useState } from "react";
import { cachedProfile, loadProfileInBackground, type Profile } from "./profile.js";

/** `email` doubles as the enable switch and as the cache's owner check — a
 *  cached row from a previous sign-in in this tab must not paint. Pass
 *  null/undefined for an anonymous view and nothing is fetched. */
export function useProfile(apiBase: string, email: string | null | undefined): Profile | null {
  const [profile, setProfile] = useState<Profile | null>(() => (email ? cachedProfile(email) : null));

  useEffect(() => {
    if (!email) {
      setProfile(null);
      return;
    }
    // Re-seed on an identity change: the state initialiser only ran once.
    setProfile(cachedProfile(email));
    return loadProfileInBackground(apiBase, setProfile);
  }, [apiBase, email]);

  return profile;
}
