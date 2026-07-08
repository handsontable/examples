# Self-hosting the Sandpack classic bundler (Phase 2, optional)

Tier-1 live editing uses the Sandpack **classic** in-browser bundler
(ADR-0013). Phase 1 uses Sandpack's public hosted bundler — already free and
CodeSandbox-cost-free, with a built-in service worker cache. Phase 2 (optional
hardening) self-hosts that bundler so nothing at runtime depends on a
third-party host.

## Why

- Remove the last runtime dependency on a CodeSandbox-operated host.
- Full control of availability + caching.

## Build the classic bundler

The classic bundler lives in the open-source `codesandbox-client` repo:

```bash
git clone https://github.com/codesandbox/codesandbox-client
cd codesandbox-client
yarn install
yarn build:deps
yarn build:sandpack        # produces the static bundler in www/ (sandpack-bundler)
```

## Deploy

Deploy the built static bundler to Cloudflare Pages (or any static host on our
infra):

```bash
npx wrangler pages deploy www --project-name handsontable-sandpack-bundler
# -> https://handsontable-sandpack-bundler.pages.dev
```

## Point the app at it

Set the bundler URL for the authoring app and viewer:

```
VITE_SANDPACK_BUNDLER_URL=https://handsontable-sandpack-bundler.pages.dev
```

`SandpackRuntime` passes this as `bundlerURL` to `@codesandbox/sandpack-client`.
Leave it unset to use the Phase-1 hosted bundler.

## Caching

Serve the bundler assets with long, immutable cache headers and let Sandpack's
service worker cache transpiler output + dependencies. Front everything with the
Cloudflare cache.

## License

Sandpack is Apache-2.0. Keep the license notice in source; never surface
CodeSandbox marks in the UI (white-label — ADR, `theme.ts`).
