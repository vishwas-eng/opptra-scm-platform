# AGENTS.md — Opptra SCM (for Cursor / Slack ops agents)

Read this first on every SCM ops run. Deeper detail: `README.md`, `deploy/RUNBOOK.md`, `docs/PLATFORM-GUIDE.md`.

## Live stack

| Item | Value |
|------|--------|
| App | https://scm.opptra.com |
| GCP project | `opptra-applications` |
| VM | `opptra-scm` |
| Zone | `asia-south1-a` |
| App path on VM | `/opt/opptra-scm` |
| Health | `curl https://scm.opptra.com/healthz` |
| Ops summary (machine) | `GET https://scm.opptra.com/api/ops/summary` |
| GitHub (org, often read-only for Cursor) | `opptra/opptra-scm-platform` |
| GitHub (Cursor write mirror) | `vishwas-eng/opptra-scm-platform` |

Containers on the VM: Caddy → API → Postgres + Redis → **Worker** (only process that talks to Unicommerce / Google / Neon).

## Ops agent auth (no Google SSO / no SSH)

`/api/runs` and `/api/admin/*` require a browser Google SSO cookie (`opptra_session`). Cloud Slack agents cannot sign in that way, and usually have no `gcloud`/SSH.

Use the **ops summary API** instead:

```bash
curl -sS -H "Authorization: Bearer $OPS_AGENT_TOKEN" \
  https://scm.opptra.com/api/ops/summary
# or: -H "X-Ops-Token: $OPS_AGENT_TOKEN"
```

Returns: 7-day week totals, inflight queue counts, per-automation counts, recent failed runs, UC session status flags (never the JSESSIONID).

**Setup (once):**

1. Generate: `openssl rand -hex 32`
2. Put `OPS_AGENT_TOKEN=…` in the VM `/opt/opptra-scm/.env` (same as compose `env_file`)
3. Redeploy / recreate API container so it picks up the env
4. Put the **same** value in Cursor Automation **secrets** as `OPS_AGENT_TOKEN`

**Never** paste the token into Slack, commits, or screenshots. If leaked, rotate on VM + Cursor secrets.

`/healthz` stays public and only proves the process is up — it does **not** mean runs/admin are visible.

Cloud agents: prefer ops summary over SSH. SSH/deploy only works if Cursor secrets include working gcloud/SSH to `opptra-scm`; do not assume that.

## Cost profile (Cursor + GCP) — keep this cheap

### Cursor Automations

- Each automation run ≈ one cloud agent bill. Prefer **fewer, smarter runs**.
- Recommended cron for **SCM Ops**: every **2 hours** (`0 */2 * * *`). Urgent path: humans `@Cursor` in `#scm-ops`.
- Do **not** use 5–15 min polling unless the human insists — that burns credits.
- On cron: **stay silent** if nothing material; one consolidated Slack reply max per run.
- Act only on clear ops issues or messages matching keywords / `@Cursor` (see automation Instructions). Skip casual chat.
- Two automations both on hourly = ~2× cost. Prefer Ops every 2h; Automation Builder every 2–4h (or merge later).

### GCP VM (`opptra-scm`)

- Default provisioner uses **`e2-medium`** (2 vCPU / 4 GB) — usually enough for this stack.
- Do **not** resize/stop the live VM without explicit human approval.
- Cheap wins (recommend only): confirm machine is still e2-medium (not oversized); Redis already capped at 256mb; rotate Docker logs (`json-file` max-size); avoid running heavy one-off analytics on the web VM; keep a single worker (required for UC session correctness anyway).

## Deploy (no GitHub CI)

```bash
./deploy/update.sh opptra-applications
```

This tars the working tree, `gcloud compute scp` to the VM, unpacks under `/opt/opptra-scm`, `docker compose up -d --build`, then hits `/healthz`.

**Logs (humans / agents with gcloud only):**

```bash
gcloud compute ssh opptra-scm --zone asia-south1-a --project opptra-applications \
  --command 'sudo docker compose -f /opt/opptra-scm/docker-compose.yml logs --tail=200 api worker'
```

## Ops workflow (Slack `#scm-ops`)

Private channel `C0BM3QXFT16`. Slack “new message” triggers do **not** work on private channels — use cron + Read Slack (catch-up) and `@Cursor` for urgent.

1. People report issues in `#scm-ops` (prefer `@Cursor` for urgent; cron catches unreplied keyword issues).
2. Investigate via repo + `/api/ops/summary` (not Google SSO admin UI).
3. Fix in the working copy → run relevant package tests.
4. **Before ship:** post Problem / Impact / Root cause / files changed / test results in `#scm-ops` and **wait**.
5. Ship only after explicit human approve: `deploy` / `go` / `ship it` / `yes deploy`.
6. On approve, prefer: commit → push to **`vishwas-eng/opptra-scm-platform`** (Cursor write) → `./deploy/update.sh opptra-applications`. Do not push to org repo if write is blocked; say so in Slack.
7. Never force-push. Never commit or print secrets (`.env`, tokens, cookies, JSESSIONID).

## Core product rules (do not break)

1. Only the **worker** calls Unicommerce. API enqueues jobs.
2. UC session death = HTTP 401 / login-redirect / `USER_NOT_LOGGED_IN` only — not `successful:false` or 403.
3. Internal UC `/data` calls are serialized (facility is session-global).
4. Every action = a Run row.
5. Mutating UC calls never blind-retry.
6. Master sheet is an **IMPORTRANGE mirror** — never overwrite; push/sync refuse; date-tab headers are literal labels, not formula clones.

## Automations map

| Area | Package / notes |
|------|------------------|
| Sheet Update | `packages/automation-sheet` — Waypoint Neon + UC → date tabs; second fill invoices/tracking |
| Packing Mail | `packages/automation-packing` — per-user Gmail OAuth; dispatch date header is `Dispatch / Pickup Date` |
| Reverse DC | `packages/automation-reversedc` — CN → Delivery Challan; hybrid parse + edit fallback |
| E-way Bill | `packages/automation-ewaybill` — generate + PDF download |
| UC client | `packages/uc-client` — session/keepalive; scripted login may still be stub |

## Marketplace column (`phase1Mapper`)

Use `marketplaceLabelFromCustomer(customer, channel)` in `packages/automation-sheet/src/schema.js`:

| Match | Sheet value |
|-------|-------------|
| ETRADE | `E-Trade` |
| KKOC | `KKOC` |
| COCOBLU / Cocoa | `Cocoa Blue` |
| CLICKTECH / ClickTag | `ClickTag` |
| Swiggy / Instamart | `Swiggy` |
| Flipkart | `Flipkart` |
| Everything else | Waypoint `customer_code` as-is |

Do **not** collapse Amazon family into `AZ Etrade`.

## Common live failures

| Symptom | Likely cause |
|---------|----------------|
| UC / Reverse DC 401 | Dead UC session — Admin paste fresh JSESSIONID (bot `sc.automations@opptra.com`) |
| Sheet Master write refused | Expected — Master is IMPORTRANGE |
| Packing missing dispatch date | Sheet column is `Dispatch / Pickup Date`, not `Dispatch Date` |
| Brand invented from warehouse | Do not derive Brand from facility name (e.g. `Opp_WIQ_*` ≠ brand WIQ) |
| Agent gets 401 on `/api/runs` | Expected without SSO — use `/api/ops/summary` + `OPS_AGENT_TOKEN` |

## Secrets

Live secrets live in VM `.env` (and local `.env` for humans). Cursor Automation secrets hold `OPS_AGENT_TOKEN` (and optionally gcloud for deploy). Do not paste Neon / Google / UC / ops tokens into Slack.
