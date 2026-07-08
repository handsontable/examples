# Generic Tier-2 live-preview image. No baked deps: proxyToSandbox requires a
# single `Sandbox` DO namespace/image, so one image serves every framework and
# the Worker installs each demo's dependencies at session start, then runs the
# real dev server. EXPOSE the dev ports used across frameworks (local dev only).
FROM docker.io/cloudflare/sandbox:0.12.3

WORKDIR /app

EXPOSE 3001 4200 4321 5173
