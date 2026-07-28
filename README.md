# Opptra SCM Platform

One backend and one web app for Opptra supply-chain automations — Unicommerce, Waypoint, Google Sheets/Gmail, and related ops flows.

It replaces the older scattered Apps Script tools. Production runs on a single GCP VM (`scm.opptra.com`) with a static IP and one whitelisted Unicommerce bot account.

**Live:** https://scm.opptra.com

---

## What it does

| Automation | What operators use it for |
|---|---|
| **Sheet Update** | First fill pulls Waypoint (all statuses) + optional SO numbers from Unicommerce into a dated Google Sheet tab. Second fill enriches those rows with invoice, tracking, e-way bill, and status. Master is an IMPORTRANGE mirror of the B2B source and is never overwritten by the app. |
| **Packing Mail** | Groups SOs by warehouse, creates Gmail drafts from the **operator’s own** connected Gmail, then creates invoice / e-way follow-up drafts in the same thread. |
| **Reverse DC** | Downloads a credit note by Bulk Return ID + warehouse (or from an upload), parses line items, and builds a Delivery Challan PDF. Falls back to editing the original CN when the layout cannot be verified. |
| **Return / re-dispatch** | Proven Unicommerce return + re-dispatch pipeline. |
| **ASN / E-way / Inventory** | Supporting automations under the same API + worker model. |

Every action creates a **Run** row (audit trail). Only the **worker** talks to Unicommerce.

---

## Layout

```
apps/
  api/          Fastify REST API + Google SSO + RBAC + serves the web app
  worker/       BullMQ worker — the only process that calls Unicommerce
  web/          Static SPA (Sheet, Packing, Reverse DC, Admin, …)

packages/
  core/                   config, Postgres, migrations, runs, OAuth tokens
  uc-client/              UC session, facility hopping, SO lookup
  integrations-google/    Sheets / Gmail / Drive helpers
  automation-sheet/       Waypoint + UC → date tabs / second fill
  automation-packing/     packing + invoice/e-way drafts
  automation-reversedc/   credit note → delivery challan
  automation-return/      return + re-dispatch
  automation-asn/
  automation-ewaybill/
  automation-inventory/

deploy/                   one-click GCP bootstrap, update script, runbook
docs/                     architecture, platform guide, security notes
```

---

## Core rules (do not break)

1. **Only the worker calls Unicommerce.** The API enqueues jobs; one process owns the session.
2. **Session death = HTTP 401 / login-redirect / `USER_NOT_LOGGED_IN` only.** `successful:false` and 403 are business responses — never treat them as a dead session.
3. **Internal `/data` calls are serialized** (facility context is session-global).
4. **Every action = a Run row.** No anonymous automation.
5. **Mutating UC calls never blind-retry.** Idempotency comes from state-based pipelines.
6. **Never write into Master when it is an IMPORTRANGE mirror.** Push / Sync refuse; date tabs get literal header text, not the formula.

---

## Develop

Requires Node.js 20+.

```bash
cp .env.example .env   # fill in local values — never commit .env
npm install
npm test               # unit tests (no DB required for most packages)
npm run check          # syntax check
```

Useful scripts:

```bash
npm run api            # API on :8080
npm run worker         # BullMQ worker
npm run migrate        # apply SQL migrations
```

---

## Deploy

```bash
# First time on a fresh GCP project
./deploy/one-click-gcp.sh <PROJECT_ID>

# Ship code changes to the existing VM
./deploy/update.sh <PROJECT_ID>
```

See [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) for ops details (session paste, Google connect, SSL, etc.).

---

## Auth model

| Concern | How it works |
|---|---|
| Human login | Google SSO, restricted to `ALLOWED_DOMAIN` (e.g. `opptra.com`) |
| Packing Mail Gmail | Each operator connects **their own** Gmail (per-user OAuth refresh token) |
| Sheets / shared Workspace | Admin “Connect shared Workspace” grant used for Master / warehouse-email sheet reads |
| Unicommerce | One bot account; JSESSIONID kept alive by the worker (Admin paste or env override) |

---

## Docs

| Doc | Purpose |
|---|---|
| [`docs/PLATFORM-GUIDE.md`](docs/PLATFORM-GUIDE.md) | How to use the platform day to day |
| [`docs/automation-design.html`](docs/automation-design.html) | Automation design walkthrough |
| [`docs/architecture.html`](docs/architecture.html) | System architecture |
| [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) | Deploy & operate the VM |
| [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md) | Security notes |
| [`docs/CODE-READINESS.md`](docs/CODE-READINESS.md) | Migration / readiness audit |

---

## Environment

Copy [`.env.example`](.env.example) to `.env`. Important groups:

- **Unicommerce** — base URL, bot user, keepalive, rate limits
- **Google SSO** — OAuth client, allowed domain, JWT secret
- **Google Workspace** — shared sheet IDs, packing warehouse-email sheet, optional SA
- **Waypoint** — Neon DB URL (preferred) or CSV export base URL
- **Postgres / Redis** — provided by Docker Compose in production

Never commit real `.env`, cookies, or service-account keys.

---

## License

Private — Opptra internal use.
