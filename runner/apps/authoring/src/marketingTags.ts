// The marketing tags — the HubSpot tracking code and the Reo.dev tag — behind the
// Cookiebot consent banner handsontable.com uses (ADR-0044).
//
// Only the SPA document runs this. `/d/:id` and `/embed/:id` are the user's own
// demo, served by the API worker, and never carry it; neither do Tier-2 previews.
// The decision itself is `marketingGate.ts`, where it can be tested.

import { getToken } from "./auth.js";
import { looksSignedIn, marketingConsented, offerMarketingTags, type CookiebotShape } from "./marketingGate.js";
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
  const loadIfConsented = () => {
    if (loaded || !marketingConsented(w.Cookiebot)) return;
    loaded = true;
    addScript(HUBSPOT_SRC).id = "hs-script-loader";
    addScript(`https://static.reo.dev/${REO_CLIENT_ID}/reo.js`).onload = () =>
      w.Reo?.init({ clientID: REO_CLIENT_ID });
  };
  // `CookiebotOnConsentReady` fires once a stored or implied answer is known,
  // `CookiebotOnAccept` when the visitor accepts in the banner.
  window.addEventListener("CookiebotOnConsentReady", loadIfConsented);
  window.addEventListener("CookiebotOnAccept", loadIfConsented);
  // A withdrawal mid-visit: HubSpot drops its cookies; the scripts themselves go
  // with the next page load, which no longer loads them.
  window.addEventListener("CookiebotOnDecline", () => {
    if (loaded) (w._hsq = w._hsq || []).push(["revokeCookieConsent"]);
  });

  const banner = addScript("https://consent.cookiebot.com/uc.js");
  banner.id = "Cookiebot";
  banner.dataset.cbid = COOKIEBOT_ID;
}
