# Opptra SCM Platform

One backend + one web app for all Opptra supply-chain automations (Unicommerce, Waypoint,
Vinculum). Replaces the scattered Apps Script apps; runs on a single GCP VM with a static IP
and a whitelisted Unicommerce bot account.

**Docs:** [`../MASTER-BACKEND-PLAN.md`](../MASTER-BACKEND-PLAN.md) (architecture & phases) ·
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) (deploy & operations) ·
[`docs/CODE-READINESS.md`](docs/CODE-READINESS.md) (migration audit)

## Layout

```
apps/api        Fastify REST API + serves the web app  (Google SSO, RBAC, runs/audit)
apps/worker     BullMQ worker — the ONLY process that talks to Unicommerce
apps/web        Static SPA (Dashboard, Return Flow, Admin; more tabs per migration phase)
packages/core   config (zod), logger (pino), Postgres + migrations, runs/audit, alerts
packages/uc-client            UC session manager + bearer + facility-safe HTTP
packages/automation-return    Return + re-dispatch pipeline (proven flow, ported)
```

## Core invariants (do not break)

1. **Only the worker calls Unicommerce.** The API enqueues; one process owns the session.
2. **Session death = HTTP 401 / login-redirect / USER_NOT_LOGGED_IN only.** `successful:false`
   and 403 are business responses (the b2b @53 lesson) — never widen death detection.
3. **Internal `/data` calls are serialized** (facility context is session-global).
4. **Every action = a Run row.** No anonymous automation, ever.
5. **Mutating UC calls never blind-retry.** Idempotency comes from state-based pipelines.

## Develop

```bash
npm install
npm test          # unit tests (no DB needed)
npm run check     # (or: node --check on files)
```

## Deploy

```bash
cp .env.example .env   # fill in
./deploy/one-click-gcp.sh <PROJECT_ID>
```
