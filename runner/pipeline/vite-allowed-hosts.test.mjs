import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { viteAllowedHostEnv } from "../workers/api/src/preview-allowed-hosts.ts";

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
function rawRequest(port, headers) {
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
      socket.write(`GET / HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
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

/** A vite-hmr upgrade. Deliberately sends NO `Origin`: with one present
 *  `shouldHandle` falls through to a token check, and a rejection there would
 *  masquerade as the host-check failure this test is about. */
const wsHandshake = (port, host) =>
  rawRequest(port, [
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    // `vite-hmr`, never `vite-ping`: ping short-circuits to allowed BEFORE the
    // host check, which would make both directions pass and prove nothing.
    "Sec-WebSocket-Protocol: vite-hmr",
  ]);

/** Boot vite on its own port in `dir`, wait for it to answer, run `fn`, always kill it. */
async function withVite(dir, extraEnv, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, [VITE_BIN, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
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
