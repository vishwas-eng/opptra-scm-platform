# 6th Street (Seller Portal + IBM OMS)

**Status:** Scaffold · **UI: Coming soon (not Live)** · Agent tools blocked until session + HAR prove endpoints.  
**Owner email (pack docs):** `daniyal@opptra.com`  
**Priority:** P0 GCC, primary deliverable is **pick list + invoice + shipping label → email**.

Companion: `docs/REVERSE-ENGINEERING-PLAYBOOK.md`, `docs/connectors/HAR-CAPTURE-CHECKLIST.md`.

---

## 0. What we automate (locked scope)

### PRIMARY, Pack email pack
1. Connect VPN (`6thStreet-OMS` / `10.61.1.11` / user `OMS999`).
2. Pull **pick list** from 6th Street seller portal and/or IBM OMS (Excel/API).
3. Pull **invoice** + **shipping label** for the same order(s).
4. Email **`daniyal@opptra.com`** with those three attachments (Gmail draft-first, same pattern as Packing Mail).
5. **Selling price:** use **invoice selling price only**. Never invent price from UC, pick list, or another portal.

### SECONDARY, Inventory (UC → marketplace)
Same direction as Home Centre: **Unicommerce is source of truth** → push/update inventory on 6th Street seller portal.  
Configurable instance: `STREET6_UC_INSTANCE` (`india` default until facility mapping is confirmed).

### Explicitly out of scope (for now)
Full warehouse scan / “+1” UI click automation. Prefer reverse APIs; UI click-spam only if no API exists.

---

## 1. Access map

| Layer | URL / endpoint | Notes |
|---|---|---|
| **VPN** | Name `6thStreet-OMS`, host **`10.61.1.11` (private)** , user `OMS999` | Not reachable from internet/GCP. Need **public Forti SSL VPN hostname** from IT, or Path B. Password in VM `.env` only. |
| **Seller portal API** | `https://prod-seller-portal-backend.6thstreet.com/sellerportal/` | Reversed from Flutter `assets/.env`. Inventory + pricing JWT APIs (see `6thstreet-API-REVERSE.md`). **No VPN.** |
| **Seller portal (Flutter web)** | `https://seller-portal.6thstreet.com/#/app` | Inventory upload/update UI. Creds: `STREET6_PORTAL_*`. |
| **IBM OMS login** | `https://apg-oms.prod.coc.ibmcloud.com/wsc/store/login.do` | VPN-gated. Picklist / invoice / label live here. Creds: `STREET6_OMS_*`. |
| **IBM OMS home (post-login)** | `https://apg-oms.prod.coc.ibmcloud.com/wsc/ngstore/home.do?scFlag=Y` | Confirmed from invoice PDF footer (IBM Store Engagement). |
| **Unicommerce** | Shared India bot by default | Inventory source only (`STREET6_UC_INSTANCE=india` unless mapped otherwise). |

**Login order (human or runbook):** VPN → seller portal and/or IBM OMS → download pick list / invoice / label.

---

## 1b. Sample pack PDFs (2026-08-03)

Two files landed in operator Downloads for order **403770599** (KSA COD, Daniyal Khan / Opptra test):

| File | Kind | Evidence |
|------|------|----------|
| `403770599 test.pdf` | **Invoice** | Creator: IBM Store Engagement / Chrome. Order `403770599`, Invoice `403761095`, SKU `5056791600146`, line **Price (SAR) 85.00**, shipping 9.00, platform fee 3.00. Footer → OMS ngstore home URL above. |
| `SAC082604817.pdf` | **Shipping label** | AWB-style `SAC082604817`, embeds order `403770599`, COD **SAR 97** (= 85+9+3), Riyadh address, REDD date. |

**Selling price for pack email** = invoice line price **85.00 SAR** (not label COD total 97).

### Filename conventions (automation)

| Artifact | OMS/export naming (observed) | Normalized email attachment |
|----------|------------------------------|-----------------------------|
| Invoice | `{orderId}….pdf` (or portal export) | `{orderId}_invoice.pdf` |
| Label | `SAC########.pdf` | `{orderId}_label.pdf` |
| Pick list | (not in this sample set, still need Excel HAR) | `{orderId}_picklist.xlsx` |

Code: `@opptra/automation-6thstreet` → `artifacts.js` (`classifyStreet6Filename`, `packAttachmentName`) + `parseSixthStreetInvoiceText` in `price.js`.

Copy samples for RE (optional): `/opt/opptra-scm/docs/connectors/assets/6thstreet/` on the VM (gitignored secrets-free PDFs OK).

---

## 2. Packages

| Package | Role |
|---|---|
| `@opptra/connectors-6thstreet` | Capability registry: health, picklist, invoice, label, pack.email, inventory.push (UC→portal) |
| `@opptra/automation-6thstreet` | Pipeline: assemble attachments → Gmail draft/send to Daniyal; inventory sync stub |

Env prefix: **`STREET6_*`** (never commit values).

| Var | Purpose |
|---|---|
| `STREET6_VPN_NAME` / `STREET6_VPN_HOST` / `STREET6_VPN_USER` / `STREET6_VPN_PASS` | VPN |
| `STREET6_PORTAL_URL` / `STREET6_PORTAL_USER` / `STREET6_PORTAL_PASS` | Seller portal |
| `STREET6_OMS_URL` / `STREET6_OMS_USER` / `STREET6_OMS_PASS` | IBM OMS login |
| `STREET6_OMS_HOME_URL` | Optional override; default ngstore home above |
| `STREET6_EMAIL_TO` | Default `daniyal@opptra.com` |
| `STREET6_UC_INSTANCE` | `india` \| `uae` \| `ksa` \| `staging`, **recommend `ksa`** (sample invoice EAN SKU on KSA); VM still `india` until flipped |
| `STREET6_UC_FACILITY` | Optional facility code when known |
| `STREET6_LIVE` / `STREET6_DRY_RUN` | Mutating portal writes gated like HC |
| `STREET6_OWNER_EMAIL` | Run attribution |

---

## 3. Actions

| Action | Mutates? | Ready? | Notes |
|---|---|---|---|
| `health.ping` | no | config probe | Reports which env keys are set (never values); portal/OMS HTTP reachability when attempted |
| `picklist.download` | no | **awaiting HAR** | Excel: SKU, qty, order id, customer; **price column ignored for sell price** |
| `invoice.download` | no | **awaiting HAR** | Source of selling price; PDF shape proven via sample above |
| `label.download` | no | **awaiting HAR** | Shipping label; SAC* filenames observed |
| `pack.email` | yes (email) | scaffold | Draft/send Gmail with picklist + invoice + label; dry-run default; accepts injected artifacts (Path B) |
| `inventory.push` | yes (portal) | **awaiting HAR** + UC read | UC snapshot → portal update; `STREET6_LIVE` gate |

---

## 4. HAR checklist (blockers for live downloads)

Capture while on VPN, logged into the portal that actually serves each file:

1. **Login** (seller portal and/or IBM OMS), cookie / CSRF / session header names.
2. **Pick list download** (Excel), request URL, query, body. *(Still missing, not in PDF sample set.)*
3. **Invoice download** (PDF), confirm selling price field in PDF or companion JSON. *(Sample shape known.)*
4. **Shipping label download** (PDF). *(Sample shape known, SAC########.)*
5. **Inventory update / upload** (secondary), file upload or JSON PATCH the UI uses.

Sanitize: strip `Cookie` / `Authorization` before any commit. Send raw HAR privately.

Flutter web tip: DevTools → Network → Fetch/XHR; also watch WebSocket if the app uses it. Prefer REST replay over UI clicks.

---

## 5. VPN on GCP VM (runbook)

The app VM (`opptra-scm`) may **not** be able to establish the corporate VPN (FortiClient / SSL VPN often needs an interactive desktop or unsupported kernel modules).

| Path | When |
|---|---|
| **A. VM VPN client** | If IT allows headless FortiClient / openfortivpn on the VM, store pass in `.env`, document connect script under `deploy/street6-vpn.sh` (scaffold). |
| **B. Jump / operator laptop** | Operator on VPN runs downloads; drops files into a watched Drive folder / uploads to SCM; worker only emails. |
| **C. Site-to-site later** | IT provisions route from GCP to `10.61.1.11`, best long-term. |

Code always assumes: **session or file artifacts available to the worker**. If VPN is down, `health.ping` and downloads return honest `vpnRequired: true` / `configured: false`, never fake success.

Path B works today with injected artifacts: invoice PDF text → `parseSixthStreetInvoiceText`; label `SAC*` → classify as label; normalize names on email.

---

## 6. Price rule

```
sellingPrice = invoice.sellingPrice   // only, line Price (SAR), not COD total on label
```

Pick list may contain a price column for warehouse reference; automation must **not** use it for sell/pack decisions once invoice is present. If invoice missing → fail the order row with `missingInvoicePrice`.

---

## 7. Safety

- Secrets only on VM `.env` (and operator password managers). Rotate passwords shared in Slack/chat.
- `STREET6_LIVE=false` until inventory upload HAR is proven.
- Do not break India UC session or Home Centre routes, this package is additive.
- Gmail: draft-first (Packing Mail pattern); auto-send only when `STREET6_LIVE` or explicit `send: true`.

---

## 8. Status snapshot (engineering)

| Item | State |
|---|---|
| Docs + env schema + packages | **Done** (deployed to `opptra-scm`) |
| API routes `/api/automations/6thstreet/*` | **Done** (Coming soon / HAR-gated) |
| Connectors panel card | **Done** (Coming soon, not Live) |
| Sample invoice + label PDFs | **Captured** 2026-08-03 (order 403770599), flows documented above |
| Pick list Excel sample | **Still missing** |
| Seller portal public HTTPS | **Reachable** (HTTP 200 from VM) |
| Portal login (`daniyal@opptra.com`) | **FAIL** 2026-08-04, `Incorrect username or password` (do not retry guesses; reset with Daniyal) |
| IBM OMS without VPN | **Unreachable** (timeout from VM) |
| VPN private IP `10.61.1.11` from GCP VM | **Unreachable**; no Forti client on VM → use Path B |
| `STREET6_*` on VM `.env` | **Set** (names only reported; values never logged) |
| `STREET6_UC_INSTANCE` | Still **`india`** on VM, **recommend `ksa`**: invoice SKU `5056791600146` exists on `opptraksa` / `OPP_SLS_ML_KSA` |
| UC→portal inventory dry-run | UC read possible once instance=`ksa`; portal upload blocked on login + HAR |
| Live XHR endpoints (OMS pack) | **Need HAR** |
| E2E email with real attachments | Path B injectable; live download blocked on HAR + VPN |

*Update this file when HARs land or UC facility for 6th Street is confirmed.*
