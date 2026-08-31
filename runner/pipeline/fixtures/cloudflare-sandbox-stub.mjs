// Stands in for `@cloudflare/sandbox` when the router runs under plain Node
// (see worker-hooks.mjs). Structural only: `proxyToSandbox()` answering null
// is the "not a preview URL" path every API request takes, and the `Sandbox`
// class exists so index.ts can extend and export it. `getSandbox()` throws on
// purpose — every route under test in mcp-routes.test.mjs must have answered
// (or refused) before any container is involved, and a test that reaches a
// sandbox anyway should fail loudly rather than silently no-op.
//
// `setSandboxFactory` scripts the next `getSandbox()` for a spec that drives
// `runBuild` directly (pipeline/snapshot-build.test.mjs). Unset — the default
// — keeps the loud throw every route spec relies on.

export class Sandbox {}

let factory = null;

export function setSandboxFactory(fn) {
  factory = fn;
}

export function getSandbox(ns, id) {
  if (factory) return factory(ns, id);
  throw new Error(
    "getSandbox() called in a route test: this request should have been answered before any container was involved",
  );
}

export async function proxyToSandbox() {
  return null;
}
