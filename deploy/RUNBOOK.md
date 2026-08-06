# Runbook — Opptra SCM Platform

## First deploy (the "one click")

```bash
# 0. once per machine
gcloud auth login

# 1. fill in secrets
cp .env.example .env        # then edit .env (POSTGRES_PASSWORD, JWT_SECRET, GOOGLE_CLIENT_ID, UC_*)
# generate secrets:  openssl rand -hex 24  /  openssl rand -hex 32

# 2. deploy everything
./deploy/one-click-gcp.sh YOUR_PROJECT_ID
```

The script prints the **static IP** — send it to Unicommerce for whitelisting, and add
`http://<IP>` to the OAuth client's Authorized JavaScript origins.

### Creating the Google OAuth client (one time, 2 minutes)
GCP Console → APIs & Services → Credentials → Create Credentials → OAuth client ID →
Web application. Authorized JavaScript origins: `http://<STATIC_IP>` (later: `https://scm.opptra.com`).
Copy the client ID into `.env` → `GOOGLE_CLIENT_ID`.

## Redeploy after changes
```bash
./deploy/update.sh YOUR_PROJECT_ID
```

`update.sh` now builds the SPA and runs `scripts/preflight.js` first, so a broken
bundle or a missing env key fails on your laptop instead of after the running
containers have been replaced. To check without deploying:

```bash
node scripts/preflight.js .env.production
```

### ⚠️ Set VAULT_KEY before the first deploy of the encryption change

Connector credentials and UC session cookies are now sealed at rest (AES-256-GCM).
The key comes from `VAULT_KEY`; if it is unset, one is derived from `JWT_SECRET`
instead. That fallback works — but it means **sealing data first and setting
`VAULT_KEY` afterwards orphans every row already sealed**, and operators have to
re-paste sessions and re-connect channels.

```bash
openssl rand -base64 32     # → VAULT_KEY in /opt/opptra-scm/.env on the VM
```

`update.sh` deliberately does not ship `.env`, so add it on the VM before redeploying.
On first boot after the upgrade the worker seals any existing plaintext rows in place
and logs `sealed legacy plaintext secrets at rest`; the step is idempotent and safe to
repeat.

### The image now builds the web app

`apps/web` is a Vite SPA served from `apps/web/dist`. The Dockerfile is multi-stage:
the build stage installs devDependencies (Vite lives there) and zips the extensions
*before* the Vite build so `publicDir` carries them into `dist`. Nothing extra to run —
but if you build the image by hand, do not pass `--target base`.

## Moving to a real domain (recommended, enables HTTPS)
1. DNS A-record: `scm.opptra.com → <STATIC_IP>`
2. `.env`: `SITE_ADDRESS=scm.opptra.com`, `PUBLIC_URL=https://scm.opptra.com`
3. `./deploy/update.sh <PROJECT>` — Caddy fetches the certificate automatically.
4. Add the https origin to the OAuth client.

## Cursor / Slack ops agent token (no Google SSO)

Cloud agents cannot use browser Google SSO for `/api/runs` or Admin analytics. After deploy:

1. `openssl rand -hex 32`
2. Add `OPS_AGENT_TOKEN=…` to `/opt/opptra-scm/.env` on the VM
3. `sudo docker compose -f /opt/opptra-scm/docker-compose.yml up -d api` (or full `./deploy/update.sh`)
4. Put the **same** value in Cursor Automation secrets as `OPS_AGENT_TOKEN`
5. Test: `curl -sS -H "Authorization: Bearer $OPS_AGENT_TOKEN" https://scm.opptra.com/api/ops/summary`

Never paste this token into Slack. See `AGENTS.md`.

## Daily operations

| Situation | What to do |
|---|---|
| **Session banner red / "session dead" alert** | Admin tab → paste fresh JSESSIONID (until scripted login is live). Worker picks it up immediately. |
| Check overall health | `curl http://<IP>/healthz` or open the Dashboard |
| Ops summary (agents) | `curl -H "Authorization: Bearer $OPS_AGENT_TOKEN" https://scm.opptra.com/api/ops/summary` |
| See logs | `gcloud compute ssh opptra-scm --zone asia-south1-a` then `sudo docker compose logs -f api worker` |
| Restart everything | on the VM: `sudo docker compose restart` |
| A job seems stuck | Dashboard shows `pending_retry` runs; after ~1h of retries it fails loudly + alerts |
| DB backup (set up in week 1) | `sudo docker compose exec postgres pg_dump -U opptra opptra | gzip > backup.sql.gz` (cron → GCS) |

## Rollback
The previous image layers stay on the VM. Fastest rollback: `git checkout <last-good>` locally,
`./deploy/update.sh <PROJECT>`. (Once the repo is on GitHub, tag releases.)

## When the whitelisted UC account arrives
1. Capture ONE manual login in the browser with DevTools recording (HAR).
2. Hand the HAR to the dev/Claude session — the scripted login lands in
   `packages/uc-client/src/session.js` (`loginScripted`), and the Admin-paste bridge
   becomes a fallback only.
3. Set `UC_USER` / `UC_PASS` in `.env`, redeploy.
