# Generic builder image for the share snapshotter (ADR-0006/0012). No baked deps:
# the snapshotter installs each demo's dependencies and runs its build command.
FROM docker.io/cloudflare/sandbox:0.12.3
WORKDIR /app

# Install commands are pnpm-based (see frameworks.generated.ts), and the base
# image bundles Corepack but omits its command shim — same as containers/live.
# Keep the pnpm version in sync with PNPM_VERSION in scripts/prepare-container.mjs.
RUN node /usr/local/lib/node_modules/corepack/dist/corepack.js enable --install-directory /usr/local/bin \
  && node /usr/local/lib/node_modules/corepack/dist/corepack.js prepare pnpm@10.34.5 --activate
