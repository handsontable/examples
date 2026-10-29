// The marketing tags — the HubSpot tracking code and the Reo.dev tag — behind the
// Cookiebot consent banner handsontable.com uses (ADR-0044).
//
// Only the SPA document runs this. `/d/:id` and `/embed/:id` are the user's own
// demo, served by the API worker, and never carry it; neither do Tier-2 previews.
// The decision itself is `marketingGate.ts`, where it can be tested.

import { getToken } from "./auth.js";
import {
  consentAction,
  looksSignedIn,
  marketingConsented,
  offerMarketingTags,
  type CookiebotShape,
} from "./marketingGate.js";
import { PRODUCTION_HOST } from "./reportingGate.js";

/* Public identifiers, the same ones handsontable.com ships: the Cookiebot account
   (handsontable.com-v3 `src/content/data/cookiebot.ts`), and the HubSpot portal and
   Reo client its GTM container loads. */
const COOKIEBOT_ID = "ef171f1d-a288-433f-b680-3cdbdebd5646";
const HUBSPOT_SRC = "https://js-eu1.hs-scripts.com/147178780.js";
const REO_CLIENT_ID = "84883421d90cd49";

type MarketingWindow = Window & {
  Cookiebot?: CookiebotShape;
  Reo?: { init(options: { clientID: string }): void };
  _hsq?: unknown[];
};

function addScript(src: string): HTMLScriptElement {
  const script = document.createElement("script");
  script.src = src;
  script.async = true;
  document.head.appendChild(script);
  return script;
}

/* The cookies the two tags set: Reo's six first-party cookies (docs.reo.dev,
   "Cookies & Consent Guide") and HubSpot's tracking cookies. Cleared on this
   host and on the parent domain, either of which the scripts may have used. */
const MARKETING_COOKIES = [
  "__sec__cid",
  "__sec__fid",
  "__sec__ghost",
  "__sec__token",
  "__sec__crid",
  "__sec__tid",
  "hubspotutk",
  "__hstc",
  "__hssc",
  "__hssrc",
];

function clearMarketingCookies(): void {
  const expired = "expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  for (const name of MARKETING_COOKIES) {
    document.cookie = `${name}=; ${expired}`;
    document.cookie = `${name}=; ${expired}; domain=.handsontable.com`;
  }
}

export function initMarketingTags(): void {
  let token: string | null = null;
  try {
    token = getToken();
  } catch {
    /* storage blocked: no staff session can exist in it either */
  }
  const offer = offerMarketingTags({
    hostname: window.location.hostname,
    productionHost: PRODUCTION_HOST,
    webdriver: navigator.webdriver,
    signedIn: looksSignedIn(token, window.location.hash),
  });
  if (!offer) return;

  const w = window as MarketingWindow;
  let loaded = false;
  const syncConsent = () => {
    const action = consentAction(marketingConsented(w.Cookiebot), loaded);
    if (action === "load") {
      loaded = true;
      addScript(HUBSPOT_SRC).id = "hs-script-loader";
      addScript(`https://static.reo.dev/${REO_CLIENT_ID}/reo.js`).onload = () =>
        w.Reo?.init({ clientID: REO_CLIENT_ID });
    } else if (action === "withdraw") {
      // Marketing consent withdrawn mid-visit. Reo has no stop call (its docs
      // only say not to load it without consent), so both tags' cookies go and
      // the page reloads without either script. HubSpot is also told directly,
      // in case it writes again before the reload. Only signed-out pages get
      // here, and their edits are never persisted — the edit page's
      // unsaved-work guard is staff-only, as are its tags.
      (w._hsq = w._hsq || []).push(["revokeCookieConsent"]);
      clearMarketingCookies();
      window.location.reload();
    }
  };
  // The event name does not say which way marketing went (unticking only
  // marketing fires `CookiebotOnAccept`), so every one re-reads the consent.
  for (const event of ["CookiebotOnConsentReady", "CookiebotOnAccept", "CookiebotOnDecline"]) {
    window.addEventListener(event, syncConsent);
  }

  const banner = addScript("https://consent.cookiebot.com/uc.js");
  banner.id = "Cookiebot";
  banner.dataset.cbid = COOKIEBOT_ID;
}
