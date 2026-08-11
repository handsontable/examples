// Display-only access to the signed-in user's profile (DEV-2166), for the
// surfaces that show it but never edit it: the top bar's avatar on every page,
// and the My Demos author line. The Settings page does its own thing — it needs
// in-flight and error states this hook deliberately hides.
//
// Starts from the sessionStorage cache so the avatar paints on first frame, then
// corrects itself from the network. See `profile.ts` for why the cache exists.

import { useEffect, useState } from "react";
import { cachedProfile, loadProfileInBackground, type Profile } from "./profile.js";

export function useProfile(apiBase: string, enabled: boolean): Profile | null {
  const [profile, setProfile] = useState<Profile | null>(() => (enabled ? cachedProfile() : null));

  useEffect(() => {
    if (!enabled) return;
    return loadProfileInBackground(apiBase, setProfile);
  }, [apiBase, enabled]);

  return profile;
}
