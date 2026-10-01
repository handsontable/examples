// The clean-shutdown marker check: the SigV4 signer against AWS's published
// test vector, local mode's signed MinIO HEAD (200/404/5xx), production's
// untouched R2 `head`, and `InboxWriter.resolveWakes` committing a wake from
// a local-mode marker.
// Run: node --experimental-strip-types --test pipeline/o11y-marker.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { markerExists, signV4 } = await import("../workers/o11y/src/inbox/marker.ts");
const { InboxWriter } = await import("../workers/o11y/src/inbox/writer.ts");
const { makeEnv, makeDurableObjectStorage } = await import("./fixtures/o11y-harness.mjs");

/** Replaces global fetch for one test; restores it after. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const localEnv = (extra = {}) => ({ O11Y_ENV: "local", O11Y_LOCAL_MINIO_PORT: "4402", ...extra });

test("signV4 reproduces AWS's published get-vanilla signature", async () => {
  const authorization = await signV4({
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
    amzDate: "20150830T123600Z",
  });
  assert.equal(
    authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("local mode: HEAD against MinIO path-style, signed, 200 = present", async () => {
  await withFetch(
    () => new Response(null, { status: 200 }),
    async (calls) => {
      assert.equal(await markerExists(localEnv(), "w1"), true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://localhost:4402/loki/state/wakes/w1/clean");
      assert.equal(calls[0].init.method, "HEAD");
      assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=minioadmin\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    },
  );
});

test("local mode: LOKI_S3_BUCKET and credentials override the defaults", async () => {
  await withFetch(
    () => new Response(null, { status: 200 }),
    async (calls) => {
      await markerExists(localEnv({ LOKI_S3_BUCKET: "probe", LOKI_S3_ACCESS_KEY_ID: "ak", LOKI_S3_SECRET_ACCESS_KEY: "sk" }), "w1");
      assert.equal(calls[0].url, "http://localhost:4402/probe/state/wakes/w1/clean");
      assert.match(calls[0].init.headers.authorization, /Credential=ak\//);
    },
  );
});

test("local mode: 404 = absent", async () => {
  await withFetch(
    () => new Response(null, { status: 404 }),
    async () => assert.equal(await markerExists(localEnv(), "w1"), false),
  );
});

test("local mode: any other status rejects instead of reading as clean or absent", async () => {
  for (const status of [403, 500, 503]) {
    await withFetch(
      () => new Response(null, { status }),
      async () => assert.rejects(markerExists(localEnv(), "w1"), new RegExp(String(status))),
    );
  }
});

test("production mode: reads O11Y_LOKI_STATE.head and never calls fetch", async () => {
  const heads = [];
  const env = { O11Y_ENV: "production", O11Y_LOKI_STATE: { head: async (key) => (heads.push(key), key.includes("present") ? {} : null) } };
  await withFetch(
    () => assert.fail("production must not fetch"),
    async (calls) => {
      assert.equal(await markerExists(env, "present"), true);
      assert.equal(await markerExists(env, "absent"), false);
      assert.equal(calls.length, 0);
    },
  );
  assert.deepEqual(heads, ["state/wakes/present/clean", "state/wakes/absent/clean"]);
});

test("InboxWriter.resolveWakes in local mode commits a wake whose marker MinIO holds, and leaves the rest for redrain", async () => {
  const doStorage = makeDurableObjectStorage();
  const { env } = makeEnv(InboxWriter, { doStorage, env: localEnv() });
  // The R2 binding is the sim the marker is NOT in: a head here would say unclean.
  env.O11Y_LOKI_STATE = { head: async () => null };
  env.GRAFANA_BOX = { jurisdiction() { return this; }, getByName: () => ({ isAwake: async () => false }) };
  const writer = new InboxWriter({ storage: doStorage, waitUntil() {} }, env);

  for (const [i, wakeId] of ["w-clean", "w-unclean", "w-last"].entries()) {
    await writer.recordWake(wakeId, "visit");
    await doStorage.put({ [`key:inbox/worker/2026-01-01/00/00000000000${i}.ndjson.gz`]: `provisional:${wakeId}` });
  }

  await withFetch(
    (url) => new Response(null, { status: String(url).includes("/w-clean/") ? 200 : 404 }),
    async () => writer.resolveWakes(),
  );

  assert.equal(await doStorage.get("done:inbox/worker/2026-01-01/00/000000000000.ndjson.gz") !== undefined, true, "marker present: committed");
  assert.equal(await doStorage.get("key:inbox/worker/2026-01-01/00/000000000001.ndjson.gz"), "written", "marker absent: back to written");
});
