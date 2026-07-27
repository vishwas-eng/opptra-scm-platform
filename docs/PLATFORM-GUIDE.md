# Opptra SCM Platform - Owner's Guide

The one document for whoever owns this platform: what it is, what it costs, how far it scales, what upkeep it needs, and how to keep building on it.

Last updated: 24 Jul 2026

---

## 1. What this is

One web app at **https://scm.opptra.com** that replaces 9 scattered Google Apps Script automations with a single reliable system. Users sign in with their @opptra.com Google account and run supply-chain automations from a browser. No scripts, no spreadsheet formulas, no shared passwords.

**Live automations (4):**

| Automation | What it does | Depends on |
|---|---|---|
| ASN Compile | Enter an SO number, get the marketplace's ASN file (marketplace auto-detected) | Unicommerce |
| Reverse DC | Upload a credit note PDF, get back a Delivery Challan | Nothing external |
| Packing Mail | Paste SO numbers, get per-warehouse Gmail drafts with invoices attached, review, send | Unicommerce + Gmail |
| Sheet Update | Waypoint orders into the B2B sheet, invoice enrichment, Master push, hourly source sync | Neon DB + Sheets + Unicommerce |

**Built but switched off in the UI (5):** Return Flow, E-way Bill, Inward/Outward, Reports Digest, Home Centre Sync. The code is ported and tested; enabling each is a UI change, not a build.

---

## 2. Architecture, in plain terms

Everything runs on **one small Google Cloud server** (VM `opptra-scm`, Mumbai region, project `opptra-applications`), as 5 containers:

```
                         https://scm.opptra.com
                                  |
                            [ Caddy ]          auto-HTTPS, the only public door
                                  |
                            [ API ]            login, permissions, job queue, web app
                             |    |
                    [ Postgres ]  [ Redis ]    users/runs/audit    job queue
                                  |
                            [ Worker ]         the ONLY process that talks to
                                               Unicommerce, Google, Neon
```

**Why one worker, on purpose:** Unicommerce gives us ONE bot session (`sc.automations@opptra.com`), and its internal API is facility-scoped. Two workers sharing one session corrupt each other's facility state. Serial execution is a correctness guarantee, not a shortcut. The worker also throttles all Unicommerce calls to 4 per second so we never trip their rate limits.

**External connections:**
- **Unicommerce** - bot account; internal session pasted by an admin when it expires
- **Google Sheets/Gmail** - authorized once by an admin via the "Connect Google Workspace" button; refresh token stored, renews itself
- **Neon Postgres** - Waypoint's own database, read-only; no cookies or sessions to maintain
- **Source B2B sheet** - read-only; synced into our Master hourly

**Data on the server:** users/roles, run history, audit log, the Unicommerce session, the Google token. The business data itself lives where it always did: the Google Sheet and Unicommerce.

---

## 3. Capacity: how many users can it handle?

Two different limits, and it matters which one you hit:

**Browsing and clicking (API):** hundreds of simultaneous users, comfortably. 100 users refreshing dashboards is under 50 requests per second; load tests processed 200 queued jobs at ~1,100 jobs/minute of queue throughput on this hardware. This is not the bottleneck.

**Actually running automations (Worker):** jobs run **one at a time**, deliberately (see above). A typical job takes seconds (ASN compile ~5-15s, sheet first-fill ~20-40s, packing mail ~10-30s per warehouse). Practical throughput is roughly **60-200 automation runs per hour**. If 100 people submit at the same moment, everyone's job queues and completes in order; nothing breaks, later jobs just wait. The dashboard shows queue position honestly.

**Rule of thumb:** 100 users who each run a handful of automations per day = completely comfortable. The system degrades by queuing, never by crashing; there is also a backpressure guard that politely rejects new jobs if the queue ever exceeds its cap.

---

## 4. Cost: today and as it grows

**Today (everything included, per month, approximate):**

| Item | Cost |
|---|---|
| VM e2-medium (2 vCPU, 4 GB, Mumbai) | ~₹2,400 ($28) |
| 50 GB disk | ~₹450 ($5.50) |
| Static IP | ~₹300 ($3.60) |
| Network egress | ~₹100 (minimal) |
| Neon, Google Sheets/Gmail APIs, Let's Encrypt HTTPS | ₹0 (free tiers / included) |
| **Total** | **~₹3,250 / ~$38 per month** |

**If usage grows, in order:**

| Trigger | Change | New total (approx) |
|---|---|---|
| Dashboard feels slow, CPU pegged | Resize VM to e2-standard-2 (1 command, ~2 min downtime) | ~$60/mo |
| Job queue regularly backs up for hours | Split per-automation workers (needs a 2nd whitelisted UC account from Unicommerce) | ~$60-70/mo |
| Database becomes precious | Move Postgres to Cloud SQL with automatic backups | +$30-50/mo |
| Serious scale (500+ daily-active) | Managed setup: Cloud SQL + Memorystore + 2 VMs behind a load balancer | ~$200-300/mo |

The honest summary: **cost stays under $40/month until job volume, not user count, forces a change**, and the first upgrade steps are cheap and one-command.

---

## 5. Ongoing effort: what upkeep does this actually need?

**Weekly-ish (2 minutes, an admin):** when the Unicommerce session expires, the dashboard pill turns "Needs attention". Log in to Unicommerce once (do the CAPTCHA), capture the session with the helper extension or paste it in Admin. Everything resumes automatically.

**Occasionally (zero to rare):**
- Google connection: renews itself; only re-connect (2 clicks) if Google ever revokes it
- Neon/Waypoint credentials: only if that team rotates them
- Disk/OS: the VM auto-restarts containers on reboot; OS patching is optional hygiene, quarterly is plenty

**Deploys:** `./deploy/update.sh opptra-applications` from this folder ships the current code in ~3 minutes. Test locally first with `./scripts/run-local.sh`.

**Backups (recommended, not yet enabled):** a nightly `pg_dump` to a GCS bucket is a 10-line cron; the truly precious data (the sheet, Unicommerce) lives outside the platform and Google versions the sheet automatically.

**Monitoring:** the platform self-alerts (log + optional Slack webhook via `SLACK_WEBHOOK_URL` in `.env`). Adding a free uptime check (e.g. GCP uptime check on `/healthz`) is worthwhile.

---

## 6. How to keep working with Claude on this

- Open a terminal in the repo folder (`opptra-scm-platform/`) and run `claude`. The project context (this codebase, its conventions, the memory of past decisions) loads automatically; describe what you want in plain words.
- The rhythm that works: **build and test locally first** (`./scripts/run-local.sh`, then the test suites), deploy once when sure. The full test suite is three commands, run separately (they share one test database): `node --test packages/*/test/*.test.js`, then `node --test apps/api/test/integration.test.js`, then `node --test apps/worker/test/*.test.js` - 100+ tests, all green means safe.
- Everything important is written down: `docs/` has the architecture diagrams (`architecture.html`, `gcp-architecture.html`), the deploy runbook (`deploy/RUNBOOK.md`), security review, and test reports.
- The reference for how the old automations behaved is the legacy `b2b-india-automation/appscript/` folder; when porting the remaining 5 automations, that code plus `unicommerce-engine/` (947 mapped endpoints) is the source of truth.

---

## 7. Current status and what remains

**Working now:** login, dashboard, all 4 automations end-to-end, hourly source sync, per-user permissions (users see only their own activity; technical detail is admin-only), request-an-automation flow, domain DNS.

**Pending, in order of importance:**

| Item | Who | Effort |
|---|---|---|
| Add `https://scm.opptra.com` to the Google OAuth client (JavaScript origins AND `https://scm.opptra.com/auth/google/callback` redirect URI) - login on the domain fails without this | You, GCP Console | 2 min |
| One deploy to activate the domain + all the UX work (batched, ready) | Claude, on your go | 3 min |
| Fresh Unicommerce session paste when you're ready to demo | Any admin | 2 min |
| Nightly database backup cron | Claude | 15 min |
| Enable the remaining 5 automations, one at a time, testing each | Claude + you testing | per automation |

**Known trade-offs accepted:** one-at-a-time job execution (Unicommerce constraint), "TalentOS" name on the Google popup (shared project branding, renaming affects another team's app), session paste stays manual (no CAPTCHA automation, by policy).
