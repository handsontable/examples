import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_HOST } from "../apps/authoring/src/reportingGate.ts";
import { looksSignedIn, marketingConsented, offerMarketingTags } from "../apps/authoring/src/marketingGate.ts";

// ADR-0044. The marketing tags (HubSpot + Reo) and their consent banner load only
// for a signed-out visitor on the production host, outside automation, and the
// tags themselves only once Cookiebot records marketing consent.

const visitor = { hostname: PRODUCTION_HOST, productionHost: PRODUCTION_HOST, webdriver: false, signedIn: false };

test("a signed-out visitor on the production host is offered the tags", () => {
  assert.equal(offerMarketingTags(visitor), true);
});

test("a browser that does not expose navigator.webdriver is still a visitor", () => {
  assert.equal(offerMarketingTags({ ...visitor, webdriver: undefined }), true);
});

test("no tags off the production host, including lookalikes and CI previews", () => {
  for (const hostname of ["localhost", "127.0.0.1", `${PRODUCTION_HOST}.evil.test`, `x.${PRODUCTION_HOST}`, undefined]) {
    assert.equal(offerMarketingTags({ ...visitor, hostname }), false, String(hostname));
  }
});

test("no tags under an automation harness", () => {
  assert.equal(offerMarketingTags({ ...visitor, webdriver: true }), false);
});

test("no tags for a signed-in staff session", () => {
  assert.equal(offerMarketingTags({ ...visitor, signedIn: true }), false);
});

test("only an explicit or implied marketing consent lets the tags load", () => {
  assert.equal(marketingConsented({ consent: { marketing: true } }), true);
  assert.equal(marketingConsented({ consent: { marketing: false } }), false);
  assert.equal(marketingConsented({ consent: {} }), false);
  assert.equal(marketingConsented({}), false);
  assert.equal(marketingConsented(undefined), false);
});

test("a staff session is the stored token or a #token= the broker just returned", () => {
  assert.equal(looksSignedIn("abc", ""), true);
  assert.equal(looksSignedIn(null, "#token=abc"), true);
  assert.equal(looksSignedIn(null, "#error=denied"), false);
  assert.equal(looksSignedIn(null, ""), false);
  assert.equal(looksSignedIn("", "#section"), false);
});
