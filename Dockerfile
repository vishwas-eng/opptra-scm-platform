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

# Non-root runtime.
USER node
EXPOSE 8080
CMD ["node", "apps/api/src/server.js"]
