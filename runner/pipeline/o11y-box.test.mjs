// Route-level proof for `GrafanaBox` (workers/o11y/src/box.ts, ADR-0041 §A),
// driven through the REAL class — not a re-declared copy of its checks.
// `@cloudflare/containers` is stubbed (cloudflare-containers-stub.mjs, via
// o11y-worker-hooks.mjs) since the real package only loads inside workerd;
// `InboxWriter` is an in-memory fake recording every `recordWake` call.
//
// Run: node --experimental-strip-types --test pipeline/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { hooks, defaultHooks } from "./fixtures/cloudflare-containers-stub.mjs";

register("./fixtures/o11y-worker-hooks.mjs", import.meta.url);

const { GrafanaBox } = await import("../workers/o11y/src/box.ts");

// --- fakes -------------------------------------------------------------

function makeStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
    // `#doWake` resets `LAST_GRAFANA_STORAGE_KEY` via
    // `ctx.storage.delete()` on every wake — this fake needed the method
    // added so every existing `wake()` test here (which all go through
    // `#doWake`) keeps working, the same class of shared-fixture addition
    // the change already made to `cloudflare-containers-stub.mjs#schedule` for
    // its own hard-cap scheduling.
    async delete(key) {
      return map.delete(key);
    },
    _map: map,
  };
}

function makeInboxWriter({ throwOn } = {}) {
  const calls = [];
  const stub = {
    async recordWake(wakeId, reason) {
      calls.push({ wakeId, reason });
      if (throwOn) throw new Error(throwOn);
    },
  };
  const namespace = {
    jurisdiction(j) {
      assert.equal(j, "eu", "InboxWriter must be addressed with .jurisdiction(\"eu\")");
      return {
        getByName(name) {
          assert.equal(name, "main", "InboxWriter must be addressed as the \"main\" instance");
          return stub;
        },
      };
    },
  };
  return { namespace, calls };
}

function makeEnv(overrides = {}) {
  const { namespace: inboxWriterNamespace, calls: inboxWriterCalls } = makeInboxWriter(overrides.inboxWriter);
  const env = {
    INBOX_WRITER: inboxWriterNamespace,
    GRAFANA_BOX: { jurisdiction: () => ({ getByName: () => ({}) }) },
    CLOUDFLARE_ACCOUNT_ID: "test-account-id",
    LOKI_S3_ACCESS_KEY_ID: "test-key-id",
    LOKI_S3_SECRET_ACCESS_KEY: "test-secret",
    AE_SQL_TOKEN: "test-ae-token",
    SLACK_WEBHOOK_URL: "https://hooks.slack.example/should-never-appear",
    O11Y_ENV: "production",
    ...overrides.env,
  };
  return { env, inboxWriterCalls };
}

function makeBox(envOverrides = {}) {
  const { env, inboxWriterCalls } = makeEnv(envOverrides);
  const ctx = { storage: makeStorage() };
  const box = new GrafanaBox(ctx, env);
  return { box, ctx, env, inboxWriterCalls };
}

test.beforeEach(() => {
  Object.assign(hooks, defaultHooks());
});

// --- wake() --------------------------------------------------------------

test("wake(): consecutive wakes (after a stop) mint distinct ids, and start() always carries the NEW id", async () => {
  const { box, inboxWriterCalls } = makeBox();
  const startedEnvVars = [];
  hooks.start = async (self, startOptions) => {
    startedEnvVars.push(startOptions.envVars);
    self._state = { status: "running", lastChange: Date.now() };
  };

  const first = await box.wake("visit");
  // Simulate the container having fully stopped since (a fresh wake cycle):
  // record what onStop would, and put the stub's own state back to
  // "stopped" the way a real container exit does.
  await box.onStop({ exitCode: 0, reason: "exit" });
  box._state = { status: "stopped", lastChange: Date.now() };

  const second = await box.wake("visit");

  assert.notEqual(first.wakeId, second.wakeId, "each wake mints a fresh id");
  assert.equal(startedEnvVars.length, 2);
  assert.equal(startedEnvVars[0].WAKE_ID, first.wakeId);
  assert.equal(startedEnvVars[1].WAKE_ID, second.wakeId);
  assert.notEqual(startedEnvVars[1].WAKE_ID, first.wakeId, "the second start never carries the first wake's id");
  assert.deepEqual(inboxWriterCalls, [
    { wakeId: first.wakeId, reason: "visit" },
    { wakeId: second.wakeId, reason: "visit" },
  ]);
});

test("wake(): idempotent while already running/healthy — no second recordWake, no second start()", async () => {
  const { box, inboxWriterCalls } = makeBox();
  let startCalls = 0;
  hooks.start = async (self) => {
    startCalls++;
    self._state = { status: "running", lastChange: Date.now() };
  };

  const first = await box.wake("backlog");
  const second = await box.wake("backlog");

  assert.equal(second.wakeId, first.wakeId, "the already-running wake's id is returned, not a new one");
  assert.equal(startCalls, 1, "start() is called exactly once");
  assert.equal(inboxWriterCalls.length, 1, "recordWake is called exactly once");
});

// `state.status === "stopping"` is not a status the real
// `@cloudflare/containers` library's `stop()` ever sets: it only signals
// SIGTERM, and `getState()` keeps reporting "running"/"healthy" until the
// process actually exits. What guards against a second wakeId during the
// real SIGTERM-pending window is the existing "running"/"healthy" branch
// returning the persisted wake record: `wake()` called right after
// `stop()` (still "running"/"healthy" here, exactly like the real library
// mid-shutdown) must return the same first wake record, with no second
// `recordWake` and no second `start()`. Deliberately uses the stub's own
// default `stop()` hook (only wrapped for a call count, never replaced),
// so this test is sensitive to both halves together.
test("wake(): idempotent while a stop() SIGTERM is in flight — never mints a second wakeId over a draining one", async () => {
  const { box, inboxWriterCalls } = makeBox();
  let startCalls = 0;
  let stopCalls = 0;
  hooks.start = async (self) => {
    startCalls++;
    self._state = { status: "running", lastChange: Date.now() };
  };
  const defaultStop = hooks.stop;
  hooks.stop = async (...args) => {
    stopCalls++;
    return defaultStop(...args);
  };

  const first = await box.wake("visit");
  assert.equal(inboxWriterCalls.length, 1);

  await box.stop();
  assert.equal(stopCalls, 1);

  const second = await box.wake("backlog");

  // The bug this guards: falling through to #doWake here would mint a
  // SECOND wakeId and call recordWake again, marking the FIRST (still
  // draining) wake `over: true` in InboxWriter's ledger before its own
  // marker exists — while start()'s own fast path may not even restart a
  // mid-shutdown process or deliver the new WAKE_ID to it.
  assert.equal(second.wakeId, first.wakeId, "the draining wake's own record is returned, not a new one");
  assert.equal(inboxWriterCalls.length, 1, "no second recordWake while the SIGTERM is still in flight");
  assert.equal(startCalls, 1, "no second start() while the SIGTERM is still in flight");
  const stillTracked = await box.ctx.storage.get("wake");
  assert.equal(stillTracked.wakeId, first.wakeId, "the persisted wake record is still the draining wake's, not a new one");
});

test("wake(): concurrent calls on a stopped box collapse into ONE start (in-flight promise)", async () => {
  const { box, inboxWriterCalls } = makeBox();
  let startCalls = 0;
  let resolveStart;
  hooks.start = async (self) => {
    startCalls++;
    await new Promise((resolve) => {
      resolveStart = resolve;
    });
    self._state = { status: "running", lastChange: Date.now() };
  };

  const p1 = box.wake("visit");
  const p2 = box.wake("visit");
  // Let both callers reach the in-flight await before resolving start().
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveStart();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.wakeId, r2.wakeId);
  assert.equal(startCalls, 1);
  assert.equal(inboxWriterCalls.length, 1);
});

test("wake(): recordWake rejecting means start() is never called (fail closed)", async () => {
  const { box, inboxWriterCalls } = makeBox({ inboxWriter: { throwOn: "InboxWriter unavailable" } });
  let startCalls = 0;
  hooks.start = async (self) => {
    startCalls++;
    self._state = { status: "running", lastChange: Date.now() };
  };

  await assert.rejects(() => box.wake("visit"), /InboxWriter unavailable/);
  assert.equal(startCalls, 0, "start() must not be called when recordWake rejects");
  assert.equal(inboxWriterCalls.length, 1, "recordWake was attempted exactly once");
});

test("wake(): missing LOKI_S3_* credentials refuses to start, and never calls recordWake with a doomed wakeId first turning into a started container", async () => {
  const { box, inboxWriterCalls } = makeBox({ env: { LOKI_S3_ACCESS_KEY_ID: undefined } });
  let startCalls = 0;
  hooks.start = async () => {
    startCalls++;
  };
  await assert.rejects(() => box.wake("visit"), /LOKI_S3_ACCESS_KEY_ID/);
  assert.equal(startCalls, 0);
  // envVars are built and validated before the storage write
  // and the recordWake call, so a missing-secret throw must leave the
  // ledger untouched — no wake was ever recorded that will never start.
  // Validating inside/after the recordWake call (the
  // original order) makes this assertion fail: recordWake fires once
  // before buildEnvVars ever gets a chance to throw.
  assert.equal(inboxWriterCalls.length, 0, "recordWake must not be called when envVars validation fails");
});

test("wake(): envVars never include SLACK_WEBHOOK_URL, and the only GF_* key is GF_SERVER_ROOT_URL", async () => {
  const { box } = makeBox();
  let envVars;
  hooks.start = async (self, startOptions) => {
    envVars = startOptions.envVars;
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");

  assert.ok(envVars, "start() was called with envVars");
  assert.ok(!("SLACK_WEBHOOK_URL" in envVars), "SLACK_WEBHOOK_URL must never reach the container");
  assert.ok(
    !JSON.stringify(envVars).includes("hooks.slack.example"),
    "the Slack webhook value must not leak into any envVar",
  );
  const gfKeys = Object.keys(envVars).filter((k) => k.startsWith("GF_"));
  assert.deepEqual(gfKeys, ["GF_SERVER_ROOT_URL"]);
});

test("wake(): production ClickHouse envVars point at the outbound-handled host and carry no credential", async () => {
  const { box } = makeBox();
  let envVars;
  hooks.start = async (self, startOptions) => {
    envVars = startOptions.envVars;
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");

  assert.equal(
    envVars.O11Y_CLICKHOUSE_URL,
    "http://ae.internal/client/v4/accounts/test-account-id/analytics_engine/sql",
  );
  assert.equal(envVars.O11Y_CLICKHOUSE_HEADER1_NAME, "");
  assert.equal(envVars.O11Y_CLICKHOUSE_HEADER1_VALUE, "");
  assert.ok(!JSON.stringify(envVars).includes("test-ae-token"), "AE_SQL_TOKEN must not reach the container");
  assert.match(envVars.LOKI_S3_ENDPOINT, /\.eu\.r2\.cloudflarestorage\.com$/);
  assert.equal(envVars.LOKI_S3_INSECURE, "false", "production R2 is always real TLS");
  assert.equal(
    envVars.LOKI_S3_BUCKET,
    "handsontable-demos-o11y-loki",
    "defaults to the production bucket name when env.LOKI_S3_BUCKET is unset",
  );
});

test("wake(): LOKI_S3_BUCKET env override reaches the container (a throwaway probe must be able to target its own bucket)", async () => {
  const { box } = makeBox({ env: { LOKI_S3_BUCKET: "o11y-probe-t03-loki" } });
  let envVars;
  hooks.start = async (self, startOptions) => {
    envVars = startOptions.envVars;
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");

  assert.equal(
    envVars.LOKI_S3_BUCKET,
    "o11y-probe-t03-loki",
    "env.LOKI_S3_BUCKET overrides the production default — a probe's own bucket name reaches the container, not a hardcoded production one",
  );
});

// --- containerFetch(): the live block and the no-auto-start gate ---------

test("containerFetch(): /grafana/api/live/ws is refused with 404 without starting the container", async () => {
  const { box } = makeBox();
  let containerFetchCalls = 0;
  hooks.containerFetch = async () => {
    containerFetchCalls++;
    return new Response("should not be reached", { status: 200 });
  };

  const res = await box.containerFetch(new Request("https://box.example/grafana/api/live/ws"));
  assert.equal(res.status, 404);
  assert.equal(containerFetchCalls, 0, "the block happens before the container is ever touched");
  assert.equal((await box.getState()).status, "stopped", "checking the live path must not start the container");
});

test("containerFetch(): bare /api/live/ and a percent-encoded variant are also refused", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of ["/api/live/ws", "/grafana/api/%6Cive/ws", "//grafana//api//live//ws"]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.equal(res.status, 404, `expected 404 for ${path}`);
  }
});

test("containerFetch(): a malformed percent-escape in the path is refused (fail closed), not silently let through", async () => {
  const { box } = makeBox();
  let containerFetchCalls = 0;
  hooks.containerFetch = async () => {
    containerFetchCalls++;
    return new Response("should not be reached", { status: 200 });
  };

  // "%ZZ" is not a valid percent-escape, so decodeURIComponent throws on
  // the whole path. The pre-fix code caught that and returned the RAW,
  // still-encoded pathname, which then did NOT match the live-path regex
  // (it contains literal "%6Cive%ZZ", not "live") — this exact path was
  // let through unblocked. It must now be refused instead.
  const res = await box.containerFetch(new Request("https://box.example/grafana/api/%6Cive%ZZ/ws"));
  assert.equal(res.status, 404);
  assert.equal(containerFetchCalls, 0, "an unparseable path must never reach the container");
});

test("containerFetch(): the live path is blocked case-insensitively", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of ["/GRAFANA/API/LIVE/ws", "/Grafana/Api/Live/", "/api/LIVE"]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.equal(res.status, 404, `expected 404 for ${path}`);
  }
});

test("containerFetch(): any websocket Upgrade request is refused regardless of path", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  const res = await box.containerFetch(
    new Request("https://box.example/grafana/", { headers: { upgrade: "websocket" } }),
  );
  assert.equal(res.status, 404);
});

test("containerFetch(): a requestOrUrl argument that cannot even be constructed into a Request is refused, not silently let through", async () => {
  const { box } = makeBox();
  let containerFetchCalls = 0;
  hooks.containerFetch = async () => {
    containerFetchCalls++;
    return new Response("should not be reached", { status: 200 });
  };

  // toInspectableRequest's catch-all returns null for an unconstructable
  // Request; the pre-fix `if (request && isBlockedLiveRequest(request))`
  // short-circuited to false on a null request, skipping the live-path
  // defense-in-depth layer entirely (it then fell through to the
  // not-running gate below, which happens to also refuse here — but for
  // an unrelated reason, and would NOT save a request arriving while the
  // box is genuinely running). Asserting 404 specifically (not just "not
  // 200") is what catches the regression: reverting the fix flips this to
  // 503 from the not-running gate instead.
  const res = await box.containerFetch("not a valid url");
  assert.equal(res.status, 404, "refused by the live-path check itself, not by an unrelated gate");
  assert.equal(containerFetchCalls, 0, "an uninspectable request must never reach the container");
});

// --- containerFetch(): the Loki datasource-proxy block ----------------------
//
// `/api/datasources/proxy/...` forwards its trailing subpath verbatim to
// whichever datasource the uid/numeric-id selector names — for both Loki
// datasources (loki-browser, loki-worker), that datasource's own `url` is
// Loki's bare root, so the subpath is Loki's real HTTP path, including its
// ingest and admin endpoints. `box.ts`'s `isBlockedLokiProxyPath` disjunct
// in `isBlockedContainerRequest` must refuse these, not just
// `LIVE_PATH_RE.test(normalized)`.

test("containerFetch(): Loki push/flush/shutdown/delete/config/otlp-ingest are refused through the uid-form datasource proxy", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of [
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/push",
    "/grafana/api/datasources/proxy/uid/loki-browser/flush",
    "/grafana/api/datasources/proxy/uid/loki-worker/ingester/shutdown",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/delete",
    "/grafana/api/datasources/proxy/uid/loki-worker/config",
    // The drain's own ingest path (box.ts's `pushToLoki`, port 3100) is
    // served at Loki's bare root too, NOT under `/loki/...` — this is
    // exactly why identification is by the uid/id selector, never by
    // guessing every dangerous `<rest>` shape (a `<rest>`-keyed denylist
    // would miss this one entirely).
    "/grafana/api/datasources/proxy/uid/loki-worker/otlp/v1/logs",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404 for ${path}, got ${res.status}`);
  }
});

test("containerFetch(): the same paths are refused through the NUMERIC-id form too (default-deny — nothing provisioned uses it)", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of [
    "/api/datasources/proxy/1/loki/api/v1/push",
    "/api/datasources/proxy/2/flush",
    "/api/datasources/proxy/1/ingester/shutdown",
    "/api/datasources/proxy/2/loki/api/v1/delete",
    "/api/datasources/proxy/1/config",
    "/api/datasources/proxy/2/otlp/v1/logs",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404 for ${path}, got ${res.status}`);
  }
});

test("containerFetch(): Loki's own read/query API still reaches the container through the datasource proxy (dashboards/legacy panels)", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  hooks.containerFetch = async () => new Response("ok", { status: 200 });
  await box.wake("visit");

  for (const path of [
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/query_range",
    "/grafana/api/datasources/proxy/uid/loki-browser/loki/api/v1/labels",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/label/env/values",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/series",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/index/stats",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/index/volume_range",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/patterns",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/detected_labels",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/format_query",
    "/api/datasources/proxy/1/loki/api/v1/query",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.equal(res.status, 200, `expected the query path to reach the container: ${path}`);
  }
});

test("containerFetch(): the ClickHouse datasource proxy (its own uid) is completely untouched by the Loki gate", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  hooks.containerFetch = async () => new Response("ok", { status: 200 });
  await box.wake("visit");

  for (const path of [
    "/grafana/api/datasources/proxy/uid/clickhouse-runner-events/",
    "/grafana/api/datasources/proxy/uid/clickhouse-runner-events?query=SELECT+1",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.equal(res.status, 200, `ClickHouse's own uid must never be blocked: ${path}`);
  }
});

test("containerFetch(): a ClickHouse query issued through the numeric-id form is ALSO refused — nothing provisioned relies on that form for anything", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  // ClickHouse happens to be provisioned 3rd (datasources.yaml), so a real
  // numeric id COULD front it — but every dashboard here references it by
  // uid only (`o11y-box-config.test.mjs` pins that), so refusing the
  // numeric-id form entirely, for every datasource, is the safe default
  // (this file's own doc comment on `isBlockedLokiProxyPath`).
  const res = await box.containerFetch(new Request("https://box.example/api/datasources/proxy/3/"));
  assert.ok(res.status === 403 || res.status === 404, `expected the numeric-id form to be refused, got ${res.status}`);
});

test("containerFetch(): percent-encoding and case variants are blocked the same way the live-path check already handles them", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of [
    "/GRAFANA/API/DATASOURCES/PROXY/UID/loki-worker/LOKI/API/V1/PUSH",
    "/grafana/api/datasources/proxy/uid/loki-worker/%6Coki/api/v1/push",
    "//grafana//api//datasources//proxy//uid//loki-worker//flush",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404 for ${path}, got ${res.status}`);
  }
});

// --- containerFetch(): the Loki datasource-resource block --------------------
//
// `/api/datasources/uid/<uid>/resources/<rest>` (and the numeric-id form)
// is Grafana's modern route. Live-verified against a real Grafana 11.4 +
// Loki plugin: reading the box's container logs shows the plugin forwards
// `<rest>` to real Loki as `/loki/api/v1/<rest>` — a genuine, working
// proxy into that URL namespace. `resources/flush`/`resources/shutdown`
// fail only because Loki's real admin endpoints live outside
// `/loki/api/v1/`, and `resources/push` independently 405s from Loki
// itself; a `--path-as-is` `../` traversal at the drain's own ingest path
// does not escape that prefix either (Loki's own router doesn't resolve
// `..` segments). None of that makes this gate optional — it is the real
// boundary, symmetric with the legacy proxy route above. The
// `DATASOURCE_RESOURCE_RE`/`LOKI_ALLOWED_RESOURCE_RE` wiring in
// `isBlockedLokiProxyPath` must refuse every case below (403/404, never
// 200).

test("containerFetch(): Loki push/flush/shutdown/config/otlp-ingest are refused through the modern uid-form resource route", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of [
    // Bare names (no loki/api/v1/ prefix): the REAL forwarding shape,
    // live-confirmed via the box's own container logs — the plugin builds
    // the outbound Loki request as `/loki/api/v1/<rest>` for exactly these.
    "/grafana/api/datasources/uid/loki-worker/resources/push",
    "/grafana/api/datasources/uid/loki-browser/resources/flush",
    "/grafana/api/datasources/uid/loki-worker/resources/shutdown",
    "/grafana/api/datasources/uid/loki-worker/resources/config",
    // Legacy-proxy-shaped guesses too (never a real forwarding shape for
    // THIS route, but must still be refused — the allowlist is on the
    // whole `<rest>`, not just the bare names above).
    "/grafana/api/datasources/uid/loki-worker/resources/loki/api/v1/push",
    "/grafana/api/datasources/uid/loki-worker/resources/ingester/shutdown",
    "/grafana/api/datasources/uid/loki-worker/resources/otlp/v1/logs",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404 for ${path}, got ${res.status}`);
  }
});

test("containerFetch(): the same resource paths are refused through the NUMERIC-id form too (default-deny)", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of [
    "/api/datasources/1/resources/loki/api/v1/push",
    "/api/datasources/2/resources/flush",
    "/api/datasources/2/resources/otlp/v1/logs",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404 for ${path}, got ${res.status}`);
  }
});

test("containerFetch(): Loki's own read/query resource handlers still reach the container (Explore/dashboard label-value variables)", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  hooks.containerFetch = async () => new Response("ok", { status: 200 });
  await box.wake("visit");

  for (const path of [
    "/grafana/api/datasources/uid/loki-worker/resources/labels",
    "/grafana/api/datasources/uid/loki-browser/resources/label/env/values",
    "/grafana/api/datasources/uid/loki-worker/resources/series",
    "/grafana/api/datasources/uid/loki-worker/resources/index/stats",
    "/grafana/api/datasources/uid/loki-worker/resources/detected_labels",
    "/grafana/api/datasources/uid/loki-worker/resources/query_range",
    "/api/datasources/1/resources/query",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.equal(res.status, 200, `expected the query resource path to reach the container: ${path}`);
  }
});

test("containerFetch(): the ClickHouse datasource's own resource route (if any) is completely untouched by the Loki gate", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  hooks.containerFetch = async () => new Response("ok", { status: 200 });
  await box.wake("visit");

  const res = await box.containerFetch(
    new Request("https://box.example/grafana/api/datasources/uid/clickhouse-runner-events/resources/anything"),
  );
  assert.equal(res.status, 200, "ClickHouse's own uid must never be blocked on the resource route either");
});

test("containerFetch(): percent-encoding and case variants of the resource route are blocked the same way", async () => {
  const { box } = makeBox();
  hooks.containerFetch = async () => new Response("should not be reached", { status: 200 });

  for (const path of [
    "/GRAFANA/API/DATASOURCES/UID/loki-worker/RESOURCES/LOKI/API/V1/PUSH",
    "/grafana/api/datasources/uid/loki-worker/resources/%6Coki/api/v1/push",
    "//grafana//api//datasources//uid//loki-worker//resources//flush",
  ]) {
    const res = await box.containerFetch(new Request(`https://box.example${path}`));
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404 for ${path}, got ${res.status}`);
  }
});

test("containerFetch(): /api/ds/query (the real backend query path Explore/dashboards use) is never touched by this gate", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  hooks.containerFetch = async () => new Response("ok", { status: 200 });
  await box.wake("visit");

  const res = await box.containerFetch(new Request("https://box.example/grafana/api/ds/query", { method: "POST" }));
  assert.equal(res.status, 200, "the backend query API is a different path entirely and must not be gated");
});

test("containerFetch(): a non-live path still reaches the container once it is running", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  hooks.containerFetch = async () => new Response("ok", { status: 200 });
  await box.wake("visit");

  const res = await box.containerFetch(new Request("https://box.example/grafana/"));
  assert.equal(res.status, 200);
});

test("containerFetch(): refuses with 503 and never auto-starts when the box is stopped", async () => {
  const { box } = makeBox();
  let startCalls = 0;
  let containerFetchCalls = 0;
  hooks.start = async () => {
    startCalls++;
  };
  hooks.containerFetch = async () => {
    containerFetchCalls++;
    return new Response("ok", { status: 200 });
  };

  const res = await box.containerFetch(new Request("https://box.example/grafana/"));
  assert.equal(res.status, 503);
  assert.equal(startCalls, 0, "an unrelated request must never trigger a wake");
  assert.equal(containerFetchCalls, 0);
});

test("a STALE persisted status (healthy) with the REAL container not running is refused, never falls through to the base class's own auto-start", async () => {
  const { box } = makeBox();
  await box.wake("visit");
  hooks.start = async (self) => {
    self._state = { status: "healthy", lastChange: Date.now() };
  };
  await box.wake("visit"); // wake() itself is a no-op here (already "running"/"healthy") — just re-asserts state

  // Model the scenario: `getState()` still says "healthy" (a
  // host loss the persisted status has not caught up with yet — its own
  // doc comment says this can lag "a few minutes"), but the REAL container
  // process is gone. Deliberately desyncs `ctx.container.running` from
  // `_state` — every OTHER test in this file relies on the stub's setter
  // keeping them in lockstep automatically; this is the one place that
  // breaks it on purpose.
  assert.equal((await box.getState()).status, "healthy", "persisted status is still stale-healthy");
  box.ctx.container.running = false;

  let baseContainerFetchCalls = 0;
  hooks.containerFetch = async () => {
    baseContainerFetchCalls++;
    return new Response("should never be reached", { status: 200 });
  };

  const res = await box.containerFetch(new Request("https://box.example/grafana/"));

  assert.equal(res.status, 503);
  assert.equal(
    baseContainerFetchCalls,
    0,
    "the base class's own containerFetch (which would auto-start with empty envVars on !container.running) must never be reached",
  );
});

// --- fetch(): the /grafana/* proxy's entry point -----------------------------
//
// `grafana/proxy.ts` calls `stub.fetch(request)`, not the `containerFetch`
// RPC method (JS RPC sends each POST body as an RPC stream, and every
// proxied POST would print "ReadableStream received over RPC disconnected
// prematurely"). These prove this entry point keeps every gate the RPC
// path had, and cannot be steered to Loki's port.

test("fetch(): proxies to Grafana's port 3000 through the gated override once running, body intact", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  const seen = [];
  hooks.containerFetch = async (_self, requestOrUrl, port) => {
    seen.push({ port, body: await requestOrUrl.text() });
    return new Response("ok", { status: 200 });
  };
  await box.wake("visit");

  const res = await box.fetch(
    new Request("https://box.example/grafana/api/ds/query", { method: "POST", body: '{"queries":[]}' }),
  );

  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ port: 3000, body: '{"queries":[]}' }]);
});

test("fetch(): a cf-container-target-port header cannot steer it to Loki's 3100", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  const ports = [];
  hooks.containerFetch = async (_self, _requestOrUrl, port) => {
    ports.push(port);
    return new Response("ok", { status: 200 });
  };
  await box.wake("visit");

  await box.fetch(
    new Request("https://box.example/loki/api/v1/push", {
      method: "POST",
      headers: { "cf-container-target-port": "3100" },
      body: "{}",
    }),
  );

  assert.deepEqual(ports, [3000], "the port is pinned to Grafana, never taken from the request");
});

test("fetch(): the live-path block, the Loki datasource allowlists and the not-running 503 all still apply", async () => {
  const { box } = makeBox();
  let reached = 0;
  hooks.containerFetch = async () => {
    reached++;
    return new Response("should not be reached", { status: 200 });
  };

  // Stopped box: 503, never auto-started.
  const stopped = await box.fetch(new Request("https://box.example/grafana/"));
  assert.equal(stopped.status, 503);
  assert.equal((await box.getState()).status, "stopped");

  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");

  for (const path of [
    "/grafana/api/live/ws",
    "/grafana/api/datasources/proxy/uid/loki-worker/loki/api/v1/push",
    "/grafana/api/datasources/uid/loki-worker/resources/push",
    "/grafana/api/datasources/proxy/3/",
  ]) {
    const res = await box.fetch(new Request(`https://box.example${path}`, { method: "POST", body: "{}" }));
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404 for ${path}, got ${res.status}`);
  }
  const ws = await box.fetch(new Request("https://box.example/grafana/", { headers: { upgrade: "websocket" } }));
  assert.equal(ws.status, 404);
  assert.equal(reached, 0, "no gated request may reach the container");
});

// --- onStop(): records what it was told, nothing more ---------------------

test("onStop(): records exactly what it received, tagged with the wake it was tracking", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  const { wakeId } = await box.wake("visit");

  await box.onStop({ exitCode: 0, reason: "exit" });
  const recorded = await box.lastStop();

  assert.equal(recorded.wakeId, wakeId);
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.reason, "exit");
  assert.ok(typeof recorded.at === "number");
});

test("onStop(): a host loss and a clean stop() report identically — onStop cannot and does not distinguish them", async () => {
  const { box } = makeBox();
  hooks.start = async (self) => {
    self._state = { status: "running", lastChange: Date.now() };
  };
  await box.wake("visit");

  // ADR-0041 §A: onStop reports { exitCode: 0, reason: "exit" } for BOTH a
  // Worker-initiated stop() and an unobserved host loss.
  await box.onStop({ exitCode: 0, reason: "exit" });
  const recorded = await box.lastStop();
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.reason, "exit");
  // onStop's job is only to record this — nothing here claims the stop was
  // clean. The marker in the Loki bucket is the only thing that claim rests
  // on (T03's ledger), never this record.
});

// --- sleepAfter override ---------------------------------------------------

test("sleepAfter: O11Y_SLEEP_AFTER shortens the idle window under O11Y_ENV=local", () => {
  const { box } = makeBox({ env: { O11Y_ENV: "local", O11Y_SLEEP_AFTER: "20s" } });
  assert.equal(box.sleepAfter, "20s");
});

test("sleepAfter: O11Y_SLEEP_AFTER is ignored in production", () => {
  const { box } = makeBox({ env: { O11Y_ENV: "production", O11Y_SLEEP_AFTER: "20s" } });
  assert.equal(box.sleepAfter, "15m");
});

test("sleepAfter: stays 15m locally when unset or not a time expression", () => {
  assert.equal(makeBox({ env: { O11Y_ENV: "local" } }).box.sleepAfter, "15m");
  for (const bad of ["soon", "20", "1d", "0s", "0m", "0h"]) {
    assert.equal(makeBox({ env: { O11Y_ENV: "local", O11Y_SLEEP_AFTER: bad } }).box.sleepAfter, "15m", bad);
  }
});
