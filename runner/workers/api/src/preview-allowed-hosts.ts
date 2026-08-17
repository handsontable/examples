// Tier-2 HMR reachability (DEV-2541).
//
// Kept out of index.ts and free of Cloudflare imports so `pipeline/` can exercise
// the derivation directly, and so the pipeline test can pair it with a real vite
// boot — the same split monitor-inject.ts uses.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// The Sandbox SDK's preview proxy is asymmetric about the `Host` it shows the dev
// server (`buildPreviewProxyRequest`, @cloudflare/sandbox):
//
//   ordinary HTTP -> rewritten to `http://localhost:<port><path>`, so vite sees
//                    `Host: localhost:<port>` and its host check always passes;
//   WS upgrade    -> `new Request(request, ...)`, i.e. the ORIGINAL preview URL,
//                    so vite sees `Host: <port>-<id>-<token>.demos.handsontable.com`.
//
// vite gates the HMR upgrade on that header (`shouldHandle` -> `isHostAllowed`),
// and `server.allowedHosts` defaults to `[]`. So the page renders perfectly while
// the HMR socket is refused with a 400 — which is exactly why this went unnoticed
// until the browser console started reporting it.
//
// This is NOT a `server.hmr` problem. The client already dials the right URL: with
// no `server.hmr` config it derives host, port and protocol from `import.meta.url`,
// which resolves to `wss://<preview-host>/`. Do not "fix" this by adding
// `--hmr.clientPort` / `--hmr.protocol` flags to a dev command: vite's CLI declares
// no `--hmr` option, so `CACError: Unknown option --hmr` aborts the process before
// it ever listens, and the session then serves the boot-failure page forever.

/**
 * The literal name of vite's additional-allowed-hosts escape hatch, pinned.
 *
 * vite reads it in `resolveServerOptions`:
 *
 *   if (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS &&
 *       Array.isArray(server.allowedHosts)) {
 *     server.allowedHosts = [...server.allowedHosts, additionalHost];
 *   }
 *
 * The name is copied rather than imported because it is double-underscore internal
 * and unversioned — there is nothing to import. If a future vite drops it we
 * degrade to today's behaviour (HMR refused, page still fine), never to a broken
 * boot, which is the right direction for a guess to fail in. That is the same
 * reasoning as the pinned `PREVIEW_PROXY_HEADER` in index.ts, and the reason
 * pipeline/vite-allowed-hosts.test.mjs boots a real vite instead of asserting on a
 * string: a silent removal upstream is the failure mode this pin cannot self-detect.
 *
 * It really does move between versions, and the containers do not run one version.
 * Three are in play, all checked against this value:
 *   - 6.4.3 — what this repo installs, so what the pipeline test can boot;
 *   - 7.3.5 — what Angular runs, pinned by `@angular/build`, not by the starter;
 *   - 8.1.1 — observed in a booted react-js container (starters pin their own vite).
 * 6.4.3 and 7.3.5 append the value verbatim. 8.1.1 splits it on commas and discards
 * it entirely — warning only — if it contains `\`, `"` or `'`. All three default
 * `allowedHosts` to `[]` and honour the leading-dot suffix wildcard. The hostname
 * pattern below excludes commas and all three reserved characters, so a single
 * value satisfies every version.
 *
 * The `Array.isArray` guard is why this is safe to set unconditionally for every
 * framework: wherever a starter already ships `server.allowedHosts: true`
 * (react-js, ant-design, mui, base-web, fluent-ui, remix, astro) the variable is a
 * no-op. Angular is covered via the builder its `angular.json` names —
 * `@angular-devkit/build-angular:dev-server` takes its esbuild branch for an
 * `:application` target, normalises an unset `allowedHosts` to `[]`, and hands
 * that array to `@angular/build`'s `serveWithVite`. Nuxt is expected to be covered
 * by the same array default, but has not been observed either way.
 */
const VITE_ADDITIONAL_ALLOWED_HOSTS = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";

/** Hostnames vite already allows unconditionally, so the variable is dead weight. */
const isNativelyAllowed = (hostname: string): boolean =>
  hostname === "localhost" || hostname.endsWith(".localhost");

/**
 * A bare hostname with an optional `:port`, anchored at both ends.
 *
 * Matched against the WHOLE value rather than splitting on `:` first: splitting
 * turns `https://demos.handsontable.com` into the plausible-looking hostname
 * `https`, which then passes a hostname-shaped check and yields `.https` — a
 * variable that matches nothing and leaves HMR broken with no signal at all.
 */
const PREVIEW_HOST_RE = /^([a-z0-9.-]+)(?::\d+)?$/;

/**
 * Environment for the Tier-2 dev-server process so vite accepts the HMR upgrade
 * that arrives bearing the per-session preview hostname.
 *
 * The value carries a leading dot on purpose: `isHostAllowedWithoutCache` treats
 * `.example.com` as a suffix wildcard, so one static string covers every
 * `<port>-<sessionId>-<token>.demos.handsontable.com` a session can ever produce.
 * The per-session name never has to be computed, and nothing has to be known at
 * image-build time.
 *
 * Returns `{}` — inject nothing — when there is no host to derive, when vite would
 * allow the host natively anyway (local `wrangler dev` runs on `localhost:8787`, so
 * previews are `*.localhost:8787`), or when the value does not look like a bare
 * hostname. Every rejection falls back to today's behaviour rather than risking a
 * dev server that misparses its own environment.
 *
 * @param previewHost `env.PREVIEW_HOST`, with or without a `:port` suffix.
 */
export function viteAllowedHostEnv(previewHost?: string): Record<string, string> {
  const value = (previewHost ?? "")
    .trim()
    .toLowerCase()
    // Tolerate a value that already carries the wildcard dot; one is added below.
    .replace(/^\.+/, "");

  // The capture drops any `:port`: vite compares the hostname only, so a value
  // containing `:8787` could never match and would silently do nothing.
  const hostname = PREVIEW_HOST_RE.exec(value)?.[1];

  if (!hostname || isNativelyAllowed(hostname)) return {};

  return { [VITE_ADDITIONAL_ALLOWED_HOSTS]: `.${hostname}` };
}
