# One image, two commands (api / worker) — keeps versions in lockstep.
FROM node:20-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/uc-client/package.json packages/uc-client/
COPY packages/automation-return/package.json packages/automation-return/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm ci --omit=dev --no-audit --no-fund

COPY packages ./packages
COPY apps ./apps
COPY extensions ./extensions
COPY scripts ./scripts

# Package the browser extensions into the web downloads folder (self-contained image).
RUN apt-get update && apt-get install -y --no-install-recommends zip \
    && bash scripts/build-extensions.sh \
    && apt-get purge -y zip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Non-root runtime.
USER node
EXPOSE 8080
CMD ["node", "apps/api/src/server.js"]
