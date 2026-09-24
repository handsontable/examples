// Minimal coverage for `scripts/o11y-slack-capture.mjs`'s
// `createSlackCaptureServer` — previously untested. Added alongside NB7
// (re-review 2): the server used to bind every interface
// (`server.listen(port)`, no host), so `GET /_captured` (unauthenticated
// alert text) was reachable from the LAN, not just this machine.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { createSlackCaptureServer } = await import("../scripts/o11y-slack-capture.mjs");

/** `server.listen()` is async — `.address()` is `null` until the
 *  `"listening"` event fires. */
function waitListening(server) {
  return new Promise((resolve) => server.once("listening", resolve));
}

test("createSlackCaptureServer (NB7): binds loopback only, not every interface", async () => {
  const { server, close } = createSlackCaptureServer(0); // :0 — an ephemeral free port, no fixed port needed for this check
  await waitListening(server);
  try {
    const address = server.address();
    assert.equal(typeof address, "object", "server.address() must resolve to a real bound address, not a pipe/string");
    assert.equal(address.address, "127.0.0.1", "must bind loopback only — NOT 0.0.0.0/::, which would expose it to the LAN");
  } finally {
    await close();
  }
});

test("createSlackCaptureServer: captures a POST body and serves it back on GET /_captured", async () => {
  const { server, captured, close } = createSlackCaptureServer(0);
  await waitListening(server);
  try {
    const { port } = server.address();
    const postRes = await fetch(`http://127.0.0.1:${port}/some/webhook/path`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello from a test" }),
    });
    assert.equal(postRes.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].body.text, "hello from a test");

    const getRes = await fetch(`http://127.0.0.1:${port}/_captured`);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].body.text, "hello from a test");
  } finally {
    await close();
  }
});
