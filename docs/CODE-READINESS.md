# Code-Readiness Audit, is our code ready to push?

**Date:** 2026-07-22 · Verdict per automation, honest. "Ready" = runs on the platform today.
"Port" = mechanical translation (Apps Script primitives → Node equivalents, endpoints already proven).
"Discovery" = something still unknown must be captured first.

| # | Automation | Source | State | What's left | Effort |
|---|-----------|--------|-------|-------------|--------|
| 1 | **Return + re-dispatch** | `return-automation/src` (Node) | ✅ **PORTED, live on the platform now** (`packages/automation-return`, Return tab) | Prod parity run on 1 real SO | done |
| 2 | **E-way bill** | `ewaybill-app/*.gs` (671 lines) | 🟨 Port | `regenerateEWayBill` endpoint already decoded; UI tab + module | ~1–2 days |
| 3 | **ASN compile (A3)** | `AsnFill.gs` | 🟨 Port | `saleorder/fetch` mapping is pure logic; needs `exceljs` templates (Flipkart/Myntra/Zepto) | ~2 days |
| 4 | **Reverse DC (A4)** | `ReverseDc.gs` + browser pdf-lib | 🟨 Port | pdf-lib edit code exists (browser side), move server-side; invoice PDF download endpoint proven | ~1–2 days |
| 5 | **Packing mail (A2)** | `Mailer.gs` | 🟨 Port + 1 decision | Needs **Gmail domain-wide delegation** (Workspace admin, one-time) for send-as identity | ~2–3 days |
| 6 | **Sheet update (A1)** | `DailySync.gs`, `Waypoint.gs` | 🟨 Port | Google service account needs edit access to the Master sheet; Waypoint API creds to env | ~2 days |
| 7 | **Inward / Outward / Full-cycle** | `appscript/*.gs` (2,001 lines) | 🟨 Port | Endpoints in FLOWS.md are proven; same recipe | ~3–4 days |
| 8 | **Reports digest (50+ reports, OCR, email)** | Apps Script | 🟧 Port + inventory | Needs the report list + OCR approach confirmed from the live script; BullMQ chunked jobs | ~4–5 days |
| 9 | **Home Centre sync (Vinculum)** | probe scripts | 🟧 Port + discovery | RSA login + `commonJsonSearch` proven once, wrap as scheduled module | ~2–3 days |
|, | **Bulk download extension** | Chrome ext. | 🟩 Optional | Server-side "Downloads" tab replaces it naturally (backend owns the session) | ~1 day |

**The platform spine itself (built today, all tests green):**

| Piece | Status | Proof |
|---|---|---|
| Config validation (refuses bad boot) | ✅ | zod schema, exit-1 on invalid |
| UC session manager (death detection, mutex refresh, admin paste, scripted-login slot) | ✅ | 9/9 unit tests, incl. the "403 ≠ death" and "successful:false ≠ death" regressions |
| Bearer manager (password grant, early refresh, no stampede) | ✅ | unit-tested |
| Facility-serialized internal calls | ✅ | unit-tested ordering |
| Google SSO (domain-locked) + RBAC + JWT cookie | ✅ | route schemas + rate-limited |
| Run attribution + audit log | ✅ | every route writes a Run row |
| Job queue + resumable retries + keep-alive scheduler | ✅ | worker with concurrency 1 |
| Alerting (Slack, deduped) | ✅ | fail-loud on session death / stuck jobs |
| Docker stack + healthchecks + graceful shutdown | ✅ | compose validated; exercised fully on first VM boot |
| One-click GCP deploy (idempotent) | ✅ | `bash -n` clean; runs against real GCP on access day |

**Known items that CANNOT be verified before GCP/whitelisted-account access (flagged, not hidden):**
1. Full compose stack has not run end-to-end locally (no Docker on this Mac), first `one-click` run
   exercises it; healthchecks + fail-loud boot make problems visible immediately.
2. Scripted login is a stub by design, needs one HAR of the whitelisted account's manual login.
3. Google OAuth client must be created in the GCP project (2-minute console step, in RUNBOOK).
