# Generic builder image for the share snapshotter (ADR-0006/0012). No baked deps:
# the snapshotter installs each demo's dependencies and runs its build command.
FROM docker.io/cloudflare/sandbox:0.12.3
WORKDIR /app

# The base image trails Node security releases; install the official tarball.
# Keep the version and sha256 in sync with NODE_VERSION / NODE_SHA256 in
# scripts/prepare-container.mjs.
RUN curl -fsSL -o /tmp/node-v22.23.4-linux-x64.tar.gz https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.gz \
  && echo "b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406  /tmp/node-v22.23.4-linux-x64.tar.gz" | sha256sum -c - \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && tar -xzf /tmp/node-v22.23.4-linux-x64.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
  && rm /tmp/node-v22.23.4-linux-x64.tar.gz \
  && test "$(node -v)" = v22.23.4

# Install commands are pnpm-based (see frameworks.generated.ts), and the base
# image bundles Corepack but omits its command shim — same as containers/live.
# Keep the pnpm version in sync with PNPM_VERSION in scripts/prepare-container.mjs.
RUN node /usr/local/lib/node_modules/corepack/dist/corepack.js enable --install-directory /usr/local/bin \
  && node /usr/local/lib/node_modules/corepack/dist/corepack.js prepare pnpm@10.34.5 --activate
