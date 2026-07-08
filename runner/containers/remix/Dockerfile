# Tier-2 base image for the Remix example. Deps are baked so a warm container
# boots the real `remix vite:dev` (with HMR) fast; per-session source files are
# written into /app at runtime by the orchestration Worker.
#
# The base image tag MUST match the installed @cloudflare/sandbox version.
FROM docker.io/cloudflare/sandbox:0.12.3

WORKDIR /app

# Bake dependencies for the default Handsontable version. When a session pins a
# different version the Worker re-runs `npm install` (delta, cache-warm).
COPY package.json ./
RUN npm install --no-audit --no-fund --loglevel=error

# Required for local `wrangler dev` port exposure (Vite dev server port).
EXPOSE 5173
