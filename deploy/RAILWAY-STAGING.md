# Railway staging — exact steps (10 minutes)

Railway CLI token on this Mac has expired. Run **`railway login`** in a terminal first
(opens the browser). Then, from `opptra-scm-platform/`, either tell Claude "railway is
logged in, deploy staging" or run these yourself:

```bash
railway init --name opptra-scm-staging          # new project
railway add --database postgres                  # managed Postgres → provides DATABASE_URL
railway add --database redis                     # managed Redis → provides REDIS_URL

# API service (serves web app too)
railway add --service api
railway variable set --service api \
  NODE_ENV=production PORT=8080 \
  UC_BASE_URL=https://oppdoorstg.unicommerce.com \
  ALLOWED_DOMAIN=opptra.com \
  ADMIN_EMAILS=vishwas.pandey@opptra.com \
  GOOGLE_CLIENT_ID=<create OAuth client, or placeholder.apps.googleusercontent.com> \
  JWT_SECRET=$(openssl rand -hex 32) \
  DATABASE_URL='${{Postgres.DATABASE_URL}}' REDIS_URL='${{Redis.REDIS_URL}}'
railway up --service api --detach -m "api first deploy"
railway domain --service api                     # get the public URL

# Worker service (same code, different start command)
railway add --service worker
# copy the same variables, then set the start command to: node apps/worker/src/worker.js
railway up --service worker --detach -m "worker first deploy"
```

Notes:
- Both services build from this repo's Dockerfile; override the worker's start command
  (`node apps/worker/src/worker.js`) in service settings or via `railway variable set
  --service worker RAILWAY_RUN_COMMAND="node apps/worker/src/worker.js"`.
- Google sign-in works once a real GOOGLE_CLIENT_ID exists and the Railway domain is in
  its Authorized JavaScript origins; until then the API boots but login shows an error.
- Staging talks to UC **staging** (oppdoorstg) — safe to test the Return tab there.
- Production still goes to the GCP VM (static IP for the whitelist): `deploy/one-click-gcp.sh`.
