# ADR-0044: Consent-gated marketing tags on the authoring SPA

**Status:** Proposed (2026-10-28)

## Context

Posts from the company's DevRel channels (LinkedIn, X, the blog) link to
demos.handsontable.com, and the runner is where those readers actually try the
product. None of that reaches the company's marketing systems. handsontable.com
loads the HubSpot tracking code and the Reo.dev tag (through its GTM container),
but the runner loads neither. A visit that starts with a `utm_campaign` link and
ends in a demo leaves no pageview, no campaign attribution and no account match.

The runner's own telemetry is anonymous by construction (ADR-0040, ADR-0041,
ADR-0042): no cookies, no client-side identifier beyond the per-tab `hot_sid`.
That stays true. What is new is a third-party tag, owned by marketing, that sets
cookies.

## Decision

1. **The SPA only.** `apps/authoring/src/marketingTags.ts`, started from `main.tsx`
   under `safeInit`, is the only place the tags load. Every SPA route is the same
   static `index.html`, so this covers `/`, `/share/:id`, the guide and the editor.
   `/d/:id` and `/embed/:id` are the user's own demo, served by the API worker and
   framed by the SPA and by the documentation site. They never carry the tags, and
   neither do Tier-2 previews.
2. **Consent first.** The page loads the Cookiebot banner with the account
   handsontable.com uses. HubSpot (`js-eu1.hs-scripts.com/147178780.js`) and Reo
   load only once `Cookiebot.consent.marketing` is true. Every Cookiebot event
   (`CookiebotOnConsentReady`, `CookiebotOnAccept`, `CookiebotOnDecline`) re-reads
   the consent and compares it with what is loaded (`consentAction`), because the
   event name does not say which way marketing went: unticking only marketing in
   the banner fires `CookiebotOnAccept`. A withdrawal after the tags loaded clears
   their cookies and reloads the page. Reo has no stop call, and only signed-out
   pages, whose edits are never persisted, carry the tags. This is an explicit
   gate in code, not left to tag-manager settings, so a decline is honoured in
   every region.
3. **Visitors only.** The gate (`marketingGate.ts`) requires the production host
   (strict equality, as in `reportingGate.ts`), `navigator.webdriver !== true`, and
   no staff session. A staff session is detected synchronously from the broker
   token in sessionStorage or an unconsumed `#token=` fragment. `currentUser()` is
   not used: it would add a broker round-trip to every route.
4. **No GTM.** The runner loads the two tags directly rather than the whole
   handsontable.com container, whose ad pixels and conversion triggers are
   specific to that site.

## Consequences

- Visitors on demos.handsontable.com see the Cookiebot banner. Consent given on
  handsontable.com does not carry over, because the `CookieConsent` cookie is
  host-only. `demos.handsontable.com` must be in the Cookiebot domain group.
- HubSpot cookies are set on `.handsontable.com`, so a visitor is one HubSpot
  contact across the two sites.
- `/d/:id` links (the MCP API's `url` field) stay untracked by marketing; their
  views are still counted anonymously by the lite beacon. Campaign links should
  point at `/share/:id`.
- Errors thrown by the third-party scripts are already dropped by Sentry's
  cross-origin gate (`isForeignUnhandled`, `eventGate.ts`).
- None of this is visible to CI: the gate is closed on localhost and under
  webdriver. `pipeline/marketing-gate.test.mjs` pins the decision. Production
  behaviour is verified by hand after deploy (accept, decline, signed in).
