# Architecture Decision Records

Numbered records of the significant decisions for the Handsontable demo runner.
Format: Status · Context · Decision · Consequences. Supersede rather than edit
once Accepted.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-replace-codesandbox-and-render-ms.md) | Replace CodeSandbox + render-ms with a self-hosted runner | Accepted (render-ms removed, ADR-0019) |
| [0002](0002-two-tier-runtime-behind-one-adapter.md) | Two-tier runtime behind one `DemoRuntime` adapter | Accepted |
| [0003](0003-no-nodebox-no-webcontainers.md) | No Nodebox / WebContainers | Accepted |
| [0004](0004-angular-is-tier-2.md) | Angular is Tier 2 | Accepted |
| [0005](0005-version-dispatch.md) | Handsontable version dispatch (lockstep, majors 15–19) | Accepted |
| [0006](0006-prebuilt-static-shares.md) | Client shares are prebuilt-static, never live | Accepted |
| [0007](0007-auth-google-login-broker.md) | Auth via the Handsontable Google login broker | Accepted (supersedes Cloudflare Access) |
| [0008](0008-per-user-demos-and-fork-flow.md) | Per-user demos + fork flow | Accepted |
| [0009](0009-docs-only-embed.md) | Docs-only embeddable URL (frame-ancestors) | Accepted |
| [0010](0010-deploy-to-main-handsontable-account.md) | Deploy to the main Handsontable Cloudflare account | Accepted |
| [0011](0011-tier2-preview-urls-need-wildcard-domain.md) | Tier-2 preview URLs need a wildcard custom domain | Accepted (local-dev claim corrected by 0020) |
| [0012](0012-one-image-and-do-class-per-framework.md) | One container image + DO class per framework | Accepted |
| [0013](0013-sandpack-classic-bundler.md) | Sandpack classic in-browser bundler for Tier 1 | Accepted |
| [0014](0014-storage-d1-r2-kv.md) | Storage split: D1 + R2 + KV | Accepted |
| [0015](0015-pnpm-monorepo-layout.md) | pnpm monorepo under `runner/` | Accepted |
| [0016](0016-codemirror-editor.md) | CodeMirror 6 as the code editor | Accepted |
| [0017](0017-keep-render-ms-until-replaced.md) | Keep render-ms running; compat shim; remove later | Superseded by 0019 |
| [0018](0018-no-ai-attribution.md) | No AI attribution in history or code | Accepted |
| [0019](0019-docs-guide-examples-and-render-ms-removal.md) | Documentation-guide examples in the runner; remove render-ms | Accepted |
| [0020](0020-routes-in-deploy-command-not-config.md) | Worker routes live in the deploy command, not wrangler.jsonc | Accepted |
| [0021](0021-versioned-docs-examples-and-version-switch-correctness.md) | Versioned docs examples + version-switch correctness | Accepted |
| [0022](0022-self-enforced-spend-ceiling.md) | The spend ceiling is enforced by the Worker, not by Cloudflare | Accepted |
