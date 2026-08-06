# One image, two commands (api / worker) — keeps versions in lockstep.

# ---------- build stage: the SPA needs devDependencies (Vite), the runtime does not ----------
FROM node:20-slim AS webbuild
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY extensions ./extensions
COPY scripts ./scripts
# Full install (including dev) so Vite is available; this whole stage is discarded.
#
# `npm install`, not `npm ci`, and deliberately: Rollup and esbuild ship their native
# binary as a per-platform optionalDependency, and npm records only the HOST platform's
# in the lockfile (npm/cli#4828). A lockfile generated on macOS therefore has no
# @rollup/rollup-linux-x64-gnu, and `npm ci` — which installs strictly from the lock —
# produces a tree where `vite build` dies on a missing module. `npm install` resolves
# for the platform it is actually running on.
#
# This costs nothing in reproducibility where it matters: everything here is a build
# tool, the stage is thrown away, and the RUNTIME stage below still uses `npm ci` so
# the shipped dependency tree remains locked.
RUN npm install --no-audit --no-fund
# Zip the extensions FIRST: they land in apps/web/public/downloads, and Vite copies
# publicDir into dist. Build them after and they would be missing from the served app.
RUN bash scripts/build-extensions.sh
RUN npm run build -w @opptra/web

# ---------- runtime ----------
FROM node:20-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# Copy workspace manifests + sources, then install (workspaces need every package.json).
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --omit=dev --no-audit --no-fund

# The built SPA (including the extension zips under downloads/). The API serves this.
COPY --from=webbuild /app/apps/web/dist ./apps/web/dist

COPY extensions ./extensions
COPY scripts ./scripts

# Non-root runtime.
USER node
EXPOSE 8080
CMD ["node", "apps/api/src/server.js"]
