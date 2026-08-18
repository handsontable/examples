import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { viteAllowedHostEnv } from "../workers/api/src/preview-allowed-hosts.ts";
import { DOCS_VITE_SERVER_BLOCK } from "./wrap-docs-example.mjs";

// DEV-2541. Tier-2 previews reach the dev server through the Sandbox SDK proxy,
// which rewrites ordinary HTTP to `http://localhost:<port>` but forwards a
// WebSocket upgrade carrying the ORIGINAL preview `Host`. vite gates the HMR
// upgrade on `server.allowedHosts`, which defaults to `[]`, so the page renders
// and the socket is refused. We opt in with vite's `__VITE_ADDITIONAL_...` escape
// hatch.
//
// That variable is double-underscore internal and unversioned, so a routine vite
// bump could drop it and nothing else in this repo would notice: HMR would simply
// go quiet again, with no boot failure and no error. Asserting that our module
// emits the right string would not catch that. So this test boots a REAL vite
// against a throwaway project with NO vite.config and drives a REAL WebSocket
// handshake with a preview-shaped `Host`, in BOTH directions — 400 without the
// variable, 101 with it. The negative case is what proves the test measures the
// host check rather than something incidental.
//
// `shouldHandle` has TWO gates that both refuse with an indistinguishable bare 400:
// the host check, and — whenever an `Origin` header is present — a `?token=` check.
// A browser always sends `Origin`, so passing only the first gate would silence the
// warning while leaving HMR just as dead. One test therefore isolates the host gate
// (no `Origin`) and a second drives the full browser shape: preview `Host`, matching
// `Origin`, and the token read back out of the served `/@vite/client`.
//
// SCOPE, HONESTLY: the boot half pins the contract of the vite the repo has
// installed (6.4.3). Containers do not run one version — Angular runs 7.3.5 (pinned
// by @angular/build), and a booted react-js container was observed on 8.1.1 — so
// this test cannot boot any version that actually serves users. All three were
// checked by hand: same `[]` default, same leading-dot wildcard, same variable.
//
// vite 8 kept the variable but changed how it parses it: the value is now split on
// commas, and the WHOLE thing is discarded with only a log warning if it contains
// any of `\ " '` (RESERVED_ALLOWED_HOSTS_CHARACTERS_RE). Both are silent failures,
// so the value-shape assertions at the bottom pin them directly and hold for any
// vite version.

const require = createRequire(import.meta.url);
/** vite is a dependency of the authoring app, not of the runner root. Its
 *  `exports` map does not expose `./bin/vite.js`, so resolve the manifest and
 *  walk to the bin rather than resolving the bin directly. */
const VITE_BIN = join(
  dirname(require.resolve("vite/package.json", { paths: [new URL("../apps/authoring", import.meta.url).pathname] })),
  "bin",
  "vite.js",
);

/** The vite the docs Vue container actually installs (DEV-2564).
 *
 *  `vite5` is an exact `npm:vite@5.4.21` alias in the runner's devDependencies, not a
 *  range: the tests below assert what this specific version does, and a floating pin
 *  would turn any upstream 5.4.x change into a red build on a question the config-level
 *  fix has already settled. It is an alias rather than a second real `vite` because the
 *  root already resolves vite transitively.
 */
const VITE5_BIN = join(
  dirname(require.resolve("vite5/package.json", { paths: [new URL("..", import.meta.url).pathname] })),
  "bin",
  "vite.js",
);

/** A preview hostname of the shape the SDK forwards: <port>-<session>-<token>.<domain>. */
const PREVIEW_HOST = "5173-sess-tok.demos.handsontable.com";
const ALLOWED = ".demos.handsontable.com";

/** Bind :0, read what the OS handed out, release it, hand it to --strictPort.
 *  Never a fixed port — a collision here would test another worktree's server. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** Raw HTTP request over a bare socket so we control the `Host` header exactly —
 *  fetch() and http.request both derive it from the URL. Resolves the status line. */
function rawRequest(port, headers, path = "/") {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    const done = (fn) => (arg) => {
      socket.destroy();
      fn(arg);
    };
    socket.setTimeout(10_000, done(reject).bind(null, new Error("socket timeout")));
    socket.once("error", done(reject));
    socket.once("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      const eol = buf.indexOf("\r\n");
      if (eol !== -1) done(resolve)(Number(buf.slice(0, eol).split(" ")[1]));
    });
    socket.once("close", () => {
      if (!buf) reject(new Error("closed with no response"));
    });
  });
}

/** Same socket, but read to EOF and return the whole response — used to pull the
 *  per-server HMR token out of the served client, exactly as a browser would. */
function rawGet(port, path, host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = "";
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error("socket timeout"));
    });
    socket.once("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => (buf += chunk.toString("utf8")));
    socket.once("error", reject);
    socket.once("close", () => resolve(buf));
  });
}

/**
 * The HMR token vite bakes into `/@vite/client` for this server instance.
 *
 * `clientInjectionsPlugin` substitutes `__WS_TOKEN__` with `config.webSocketToken`,
 * and the client appends it as `?token=` to the socket URL. Reading it back the way
 * the browser gets it is what lets the handshake below be browser-shaped rather than
 * merely upgrade-shaped.
 */
async function hmrToken(port) {
  const body = await rawGet(port, "/@vite/client", `localhost:${port}`);
  const token = /const wsToken = "([^"]+)"/.exec(body)?.[1];
  assert.ok(token, `could not read the HMR token out of /@vite/client:\n${body.slice(0, 400)}`);
  return token;
}

/**
 * A `vite-hmr` upgrade.
 *
 * `origin`/`token` are opt-in because `shouldHandle` has two gates and they are
 * indistinguishable from the wire — both refuse with a bare 400:
 *
 *   1. the host check (`isHostAllowed`), which is what DEV-2541 is about;
 *   2. with an `Origin` header present, `hasValidToken(config, url)`.
 *
 * Omitting `Origin` isolates gate 1, which is what proves the fix. But a real
 * browser ALWAYS sends `Origin` on a WebSocket handshake, so production only ever
 * takes gate 2 as well — hence the browser-shaped test further down, which sends
 * both and therefore proves the handshake a browser makes actually completes.
 */
const wsHandshake = (port, host, { origin, token } = {}) =>
  rawRequest(
    port,
    [
      `Host: ${host}`,
      ...(origin ? [`Origin: ${origin}`] : []),
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      // `vite-hmr`, never `vite-ping`: ping short-circuits to allowed BEFORE the
      // host check, which would make both directions pass and prove nothing.
      "Sec-WebSocket-Protocol: vite-hmr",
    ],
    token === undefined ? "/" : `/?token=${token}`,
  );

/** Boot vite on its own port in `dir`, wait for it to answer, run `fn`, always kill it.
 *  `bin` defaults to the repo's own vite; pass VITE5_BIN for the docs Vue container's. */
async function withVite(dir, extraEnv, fn, bin = VITE_BIN) {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: dir,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    // Poll rather than sleep a fixed amount: a cold vite start is not a constant.
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`vite exited early (${child.exitCode}):\n${log}`);
      try {
        await rawRequest(port, [`Host: localhost:${port}`, "Connection: close"]);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`vite never became ready:\n${log}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return await fn(port);
  } finally {
    child.kill("SIGKILL");
  }
}

test("vite refuses the HMR upgrade from a preview host, and the env var fixes it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dev2541-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // No vite.config at all — the shape of the two frameworks that were broken
  // (the generated docs vue config has no `server` block; angular's dev-server
  // normalises an unset `allowedHosts` to `[]`).
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "dev2541-fixture", private: true, type: "module" }));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body>dev2541</body></html>");

  await withVite(dir, {}, async (port) => {
    assert.equal(await wsHandshake(port, `localhost:${port}`), 101, "control: localhost must always be allowed");
    assert.equal(
      await wsHandshake(port, PREVIEW_HOST),
      400,
      "without the env var vite must refuse the preview host — if this stops being 400, the bug is gone or the test stopped measuring the host check",
    );
  });

  await withVite(dir, { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ALLOWED }, async (port) => {
    assert.equal(
      await wsHandshake(port, PREVIEW_HOST),
      101,
      "with the env var vite must accept the preview host; a silent removal upstream shows up here",
    );
    assert.equal(await wsHandshake(port, `localhost:${port}`), 101, "localhost must keep working");
  });
});

test("the handshake a real browser makes completes once the env var is set", async (t) => {
  // The test above isolates the host check by omitting `Origin`. No browser does
  // that: a WebSocket handshake always carries one, so in production `shouldHandle`
  // runs the host check AND `hasValidToken`. Both refuse with an identical bare 400,
  // which is why fixing only the host check could look like a fix and still leave
  // HMR dead. This drives the full browser shape — preview `Host`, matching `Origin`,
  // and the `?token=` the vite client reads out of `/@vite/client` — end to end
  // against the dev server.
  const dir = await mkdtemp(join(tmpdir(), "dev2541-browser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "dev2541-browser", private: true, type: "module" }));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body>dev2541</body></html>");

  const origin = `https://${PREVIEW_HOST}`;

  await withVite(dir, {}, async (port) => {
    const token = await hmrToken(port);
    assert.equal(
      await wsHandshake(port, PREVIEW_HOST, { origin, token }),
      400,
      "unfixed: a valid token does not help, the host check refuses first",
    );
  });

  await withVite(dir, viteAllowedHostEnv("demos.handsontable.com"), async (port) => {
    const token = await hmrToken(port);
    assert.equal(
      await wsHandshake(port, PREVIEW_HOST, { origin, token }),
      101,
      "fixed: the exact handshake a browser sends must be accepted, not merely the host check",
    );
    // Control: the token gate is live on this same request shape, so the 101 above
    // is a real acceptance and not a check that silently stopped being enforced.
    assert.equal(
      await wsHandshake(port, PREVIEW_HOST, { origin }),
      400,
      "with an Origin and no token vite must still refuse — otherwise the 101 proves nothing about the token gate",
    );
    assert.equal(
      await wsHandshake(port, PREVIEW_HOST, { origin, token: "not-the-token" }),
      400,
      "a wrong token must still refuse",
    );
  });
});

test("the leading dot is a suffix wildcard, so one value covers every session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dev2541-wild-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "dev2541-wild", private: true, type: "module" }));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body>dev2541</body></html>");

  await withVite(dir, viteAllowedHostEnv("demos.handsontable.com"), async (port) => {
    // Two different sessions, one static allowed value.
    assert.equal(await wsHandshake(port, "4200-aaaa-bbbb.demos.handsontable.com"), 101);
    assert.equal(await wsHandshake(port, "3001-cccc-dddd.demos.handsontable.com"), 101);
    // Still a suffix match, not a substring one.
    assert.equal(await wsHandshake(port, "demos.handsontable.com.evil.example"), 400);
  });
});

test("viteAllowedHostEnv derives the wildcard from PREVIEW_HOST", () => {
  assert.deepEqual(viteAllowedHostEnv("demos.handsontable.com"), {
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".demos.handsontable.com",
  });
  // A port would never match — vite compares hostname only.
  assert.deepEqual(viteAllowedHostEnv("demos.handsontable.com:8787"), {
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".demos.handsontable.com",
  });
  // Idempotent if someone writes the wildcard into config themselves.
  assert.deepEqual(viteAllowedHostEnv(".demos.handsontable.com"), {
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".demos.handsontable.com",
  });
});

test("the derived value survives vite 8's stricter parsing", () => {
  // vite 8 (8.1.1 was observed in a booted react-js container) splits the value
  // on commas and drops it entirely — warning only, no error — if it contains any
  // of `\ " '`. A value that trips either rule leaves HMR broken exactly as if the
  // fix had never shipped, so pin both here rather than trusting the host regex to
  // keep excluding them.
  for (const host of ["demos.handsontable.com", "demos.handsontable.com:8787", "a-b.c.example"]) {
    const value = viteAllowedHostEnv(host).__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS;
    assert.ok(value, `expected a value for ${host}`);
    assert.doesNotMatch(value, /[\\"']/, "vite 8 discards the whole value on these characters");
    assert.doesNotMatch(value, /,/, "vite 8 splits on commas — one host must stay one host");
    assert.equal(value.trim(), value, "vite 8 trims each entry; leading/trailing space hides mistakes");
  }
});

test("viteAllowedHostEnv injects nothing when it would be pointless or unsafe", () => {
  // vite allows these natively, so local `wrangler dev` needs no variable at all.
  assert.deepEqual(viteAllowedHostEnv("localhost:8787"), {});
  assert.deepEqual(viteAllowedHostEnv("foo.localhost:8787"), {});
  // Nothing to derive.
  assert.deepEqual(viteAllowedHostEnv(undefined), {});
  assert.deepEqual(viteAllowedHostEnv(""), {});
  assert.deepEqual(viteAllowedHostEnv("   "), {});
  // Anything that is not a bare hostname fails toward today's behaviour.
  assert.deepEqual(viteAllowedHostEnv("https://demos.handsontable.com"), {});
  assert.deepEqual(viteAllowedHostEnv("demos handsontable com"), {});
  assert.deepEqual(viteAllowedHostEnv("demos.handsontable.com/path"), {});
});

// ── DEV-2564: the container the env var never reached ─────────────────────────
//
// Everything above pins the DEV-2541 mechanism — vite's internal
// `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`. That variable does not exist before vite
// 6. The docs Vue container is pinned to vite 5 (`vite: "^5.4.0"`, emitted by
// `buildVueProject` in wrap-docs-example.mjs and baked into
// containers/live/baked/vue-18/package.json), so on the ~500 Vue docs examples the
// DEV-2541 fix was silently inert and HMR stayed refused. Measured on 5.4.21 while
// writing DEV-2564: 400 without the variable and 400 with it — and there is no
// occurrence of the name anywhere in that version's `dist`.
//
// So the Vue config opts in from config instead, via `DOCS_VITE_SERVER_BLOCK`. These
// tests boot the REAL 5.4.21 the container installs, against the EXACT string the
// generator emits, and prove the upgrade a browser sends completes. They deliberately
// do NOT assert that the env var stays absent from vite 5: if some 5.4.x ever
// backported it the right response would be "does not matter, we use config now", and
// a red build there would be noise.

/** A throwaway project with an optional vite.config, in the shape a docs project has. */
async function fixture(t, prefix, viteConfig) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: prefix, private: true, type: "module" }));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body>dev2564</body></html>");
  // No plugin import: `@vitejs/plugin-vue` is not resolvable from a temp dir, and the
  // plugin is irrelevant to the host check. The `server` block is the whole subject,
  // and it is imported from the generator so editing that string cannot bypass this.
  if (viteConfig) await writeFile(join(dir, "vite.config.js"), viteConfig);
  return dir;
}

const DOCS_SERVER_ONLY_CONFIG = `export default { ${DOCS_VITE_SERVER_BLOCK} };\n`;

test("vite 5.4.21 refuses the preview host, and the generated server block fixes it", async (t) => {
  // Negative control first, and on the same version: without the block, 5.4.21 must
  // refuse. This is what proves the 101 below measures the host gate rather than a
  // gate that quietly stopped being enforced in this version.
  const bare = await fixture(t, "dev2564-bare-");
  await withVite(
    bare,
    {},
    async (port) => {
      assert.equal(await wsHandshake(port, `localhost:${port}`), 101, "control: localhost is always allowed");
      assert.equal(
        await wsHandshake(port, PREVIEW_HOST),
        400,
        "vite 5.4.21 with no server block must refuse the preview host — this is the bug DEV-2564 reports",
      );
    },
    VITE5_BIN,
  );

  const fixed = await fixture(t, "dev2564-fixed-", DOCS_SERVER_ONLY_CONFIG);
  await withVite(
    fixed,
    {},
    async (port) => {
      // No env var anywhere in this boot: the config alone has to carry it, which is
      // the whole point of fixing it this way rather than bumping the vite pin.
      assert.equal(
        await wsHandshake(port, PREVIEW_HOST),
        101,
        "the emitted server block must open the host gate on vite 5, with no environment variable involved",
      );
      assert.equal(await wsHandshake(port, `localhost:${port}`), 101, "localhost must keep working");

      // Browser shape, same boot — a real WebSocket handshake always carries `Origin`,
      // so `shouldHandle` also runs `hasValidToken`. 5.4.12 added both the token gate
      // and `server.allowedHosts` (CVE-2025-24010), so 5.4.21 has both and passing only
      // the host gate would leave HMR just as dead.
      const origin = `https://${PREVIEW_HOST}`;
      const token = await hmrToken(port);
      assert.equal(
        await wsHandshake(port, PREVIEW_HOST, { origin, token }),
        101,
        "the exact handshake a browser sends must be accepted, not merely the host check",
      );
      assert.equal(
        await wsHandshake(port, PREVIEW_HOST, { origin }),
        400,
        "with an Origin and no token vite must still refuse — otherwise the 101 above proves nothing",
      );
    },
    VITE5_BIN,
  );
});

test("the generated server block also covers the majors the env var reaches", async (t) => {
  // The Vue container is on 5 today, but the fix has to keep working if that pin ever
  // moves — and every other container is on 6/7/8. Booting the repo's own vite against
  // the same string, with no env var, pins the config path across majors so a future
  // bump cannot quietly land back on the broken side.
  const fixed = await fixture(t, "dev2564-cross-", DOCS_SERVER_ONLY_CONFIG);
  await withVite(fixed, {}, async (port) => {
    const origin = `https://${PREVIEW_HOST}`;
    const token = await hmrToken(port);
    assert.equal(await wsHandshake(port, PREVIEW_HOST, { origin, token }), 101);
  });
});
