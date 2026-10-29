// Whether the authoring app loads the marketing tags — the HubSpot tracking code
// and the Reo.dev tag — and whether a Cookiebot consent state lets them (ADR-0044).
//
// Split out of `marketingTags.ts` for the same reason as `reportingGate.ts:1-9`:
// that module touches the DOM and imports sibling `./x.js` modules, which
// `pipeline/marketing-gate.test.mjs` cannot resolve under
// `--experimental-strip-types`. Do not let this one grow imports.

export interface MarketingInputs {
  /** `window.location.hostname`. */
  hostname?: string;
  /** The one host the tags may run on — `PRODUCTION_HOST` at the call site. */
  productionHost: string;
  /** `navigator.webdriver` — `true` under every automation harness. */
  webdriver?: boolean;
  /** A Handsontable staff session (see `looksSignedIn`). */
  signedIn: boolean;
}

/**
 * Three conjuncts, the first two the same as `resolveReporting`'s:
 *
 * - `hostname` — strict equality, so local runs, `vite preview` in CI and any
 *   lookalike host never load the banner or the tags.
 * - `webdriver` — a Playwright run pointed at production is not a visitor.
 *   Compared against `true`, not `!webdriver`: a browser that does not expose the
 *   property reports `undefined` and is a real visitor.
 * - `signedIn` — the editor's own users are staff (ADR-0007). Their sessions would
 *   land in HubSpot and Reo as prospect activity.
 */
export function offerMarketingTags({ hostname, productionHost, webdriver, signedIn }: MarketingInputs): boolean {
  return hostname === productionHost && webdriver !== true && !signedIn;
}

/** The part of `window.Cookiebot` this gate reads. */
export interface CookiebotShape {
  consent?: { marketing?: boolean };
}

/** Marketing consent, as Cookiebot records it — given explicitly, or implied
 *  where Cookiebot's own rules imply it for the visitor's region. Anything else
 *  (no Cookiebot yet, no answer, declined) is no. */
export function marketingConsented(cookiebot: CookiebotShape | undefined): boolean {
  return cookiebot?.consent?.marketing === true;
}

/**
 * What a consent change asks of the page, given whether the tags are loaded.
 * Every Cookiebot event goes through this one rule, because the event name does
 * not say which way marketing went: unticking only marketing in the banner fires
 * `CookiebotOnAccept`, not `CookiebotOnDecline`.
 */
export function consentAction(consented: boolean, loaded: boolean): "load" | "withdraw" | "none" {
  if (consented && !loaded) return "load";
  if (!consented && loaded) return "withdraw";
  return "none";
}

/**
 * A staff session, read synchronously: the broker token in sessionStorage, or a
 * `#token=` fragment the broker has just redirected back with and `auth.ts` has not
 * consumed yet. Deliberately not `currentUser()`, which round-trips the broker
 * (see the `seedAnonymousContext` comment in `main.tsx`). A staff member in a
 * fresh, signed-out tab is counted as a visitor; that is accepted.
 */
export function looksSignedIn(token: string | null, hash: string): boolean {
  return Boolean(token) || new URLSearchParams(hash.replace(/^#/, "")).has("token");
}
