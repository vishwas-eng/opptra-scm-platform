# Platform Status — what's live, what's left

**Updated:** 2026-07-22 · Single source of truth for "what works, what's left."

## Automations

| Automation | Module | Worker | API | Web tab | Tests | Runs without new creds? |
|---|---|---|---|---|---|---|
| **Return + re-dispatch** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (needs UC session) |
| **E-way bill** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (needs UC session) |
| **Inward / Outward / Full-cycle** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (needs UC session) |
| **ASN compile** (Flipkart/Myntra/Zepto) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (needs UC session) |
| **Reverse DC** (CN → Delivery Challan) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (needs UC session) |
| **Downloads** (bulk invoice/EWB) | ✅ extension | — | — | ✅ | — | ✅ (browser session) |
| Packing mail (A2) | ⛔ needs Google | — | — | (disabled) | — | ❌ needs Gmail+Drive delegation |
| Sheet update (A1) | ⛔ needs Google + Waypoint | — | — | (disabled) | — | ❌ needs Sheets access + Waypoint API |
| Reports digest | ⛔ needs Google + report list | — | — | (disabled) | — | ❌ needs the report spec |
| Home Centre sync | ⛔ needs Vinculum | — | — | (disabled) | — | ❌ needs Vinculum creds |

**5 automations are fully ported, tested, and live in the platform.** All the UC-only
ones are done. The remaining 4 are **not code-blocked by us — they are credential/spec-blocked.**
Building them blind (untested, guessing the sheet layout / report list / Vinculum login)
would violate the clean-code bar, so they wait on the specific inputs below.

## Foundation already built for the remaining 4

`@opptra/integrations-google` (Gmail / Drive / Sheets via a service account with
domain-wide delegation) is **built and unit-tested** — MIME builder, draft/send, folder
listing, sheet read/append/update, all injectable. The config seam
(`GOOGLE_SA_KEY_JSON`, `GOOGLE_DELEGATED_USER`, `MASTER_SHEET_ID`) is in place. So
packing-mail / sheet / reports-digest are a straight port on top of it once creds land.

## Exactly what each remaining automation needs (then it's ~1–3 days each)

1. **Packing mail (A2)** — needs: (a) Google service-account **domain-wide delegation**
   for `gmail.compose`/`gmail.send`/`drive.readonly` impersonating `supplychainauto@opptra.com`;
   (b) the **Drive folder IDs** for labels + appointments; (c) the **WarehouseMap** (SO/channel → warehouse email).
   Then: compose per-warehouse drafts, attach invoice PDF (already have `uc.dataBinary`) + label/appointment + EWB.
2. **Sheet update (A1)** — needs: (a) the same Google SA with **edit** access to the
   Master sheet (`MASTER_SHEET_ID`); (b) the **Waypoint API** base + auth; (c) the Master-sheet
   tab/column layout. Then: first-fill (Waypoint CREATED → date tab) + second-fill (UC invoice enrich) + auto-push to Master.
3. **Reports digest** — needs: **the list of the ~50 reports**, which warehouses, and what
   the digest email should contain (plus whether OCR runs via Drive-convert or `tesseract.js`).
   This is the one that genuinely cannot be built correctly without the spec. Structure:
   a BullMQ scheduled job that pulls each report (UC export/download — same pattern we have),
   compiles, OCRs where needed, and emails the digest.
4. **Home Centre sync** — needs: **Vinculum credentials** + confirmation of the RSA-login
   + `commonJsonSearch` flow (documented in the `homecentre-order-sync` notes). Then: scheduled
   pull of HC orders → create UC Sale Orders (proven end-to-end already).

## Engineering practices in place (unchanged, still holding)

Single UC choke-point; global token-bucket rate limiting + 429 backoff; durable
idempotency (step ledger); Google SSO + RBAC re-checked per request; auth before
validation; run attribution + audit; fail-loud Slack alerts; **46 unit tests**; one-click
GCP deploy with auto-HTTPS. A new senior dev can read the codebase in one pass.

## The one thing still true for the live automations

A real end-to-end run needs a UC session pasted in Admin (or the whitelisted account) —
the only thing not doable from a dev machine. The code paths use the exact endpoints/payloads
already proven in the Apps Script apps.
