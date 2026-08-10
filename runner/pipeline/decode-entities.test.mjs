// The docs-link titles the chat panel shows come from DocSearch, which stores
// headings HTML-escaped (workers/api/src/chat.ts). Imported through
// `node --experimental-strip-types`; chat.ts's only import is type-only, so
// nothing Cloudflare-specific is evaluated here.
//
// It lives in pipeline/ despite testing the API worker because that is the
// repo's one `node --test` entry point (`pnpm test`) — the worker has no runner
// of its own. Move it only along with that script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities } from "../workers/api/src/chat.ts";

test("named entities decode", () => {
  assert.equal(decodeEntities("Accessibility &amp; UX"), "Accessibility & UX");
  assert.equal(decodeEntities("&lt;td&gt; &quot;cell&quot; &apos;x&apos;"), `<td> "cell" 'x'`);
});

test("numeric entities decode, decimal and hex", () => {
  assert.equal(decodeEntities("Sell date &#8250; Qty"), "Sell date › Qty");
  assert.equal(decodeEntities("&#x2039;&#X203A;"), "‹›");
});

test("one pass only — a double-escaped entity keeps its text", () => {
  assert.equal(decodeEntities("&amp;lt;"), "&lt;");
});

test("unknown and malformed entities are left alone", () => {
  assert.equal(decodeEntities("a &bogus; b"), "a &bogus; b");
  assert.equal(decodeEntities("Q&A, 100% &"), "Q&A, 100% &");
  assert.equal(decodeEntities("&#xD800;"), "&#xD800;"); // lone surrogate
});
