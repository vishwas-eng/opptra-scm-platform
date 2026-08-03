# Opptra Connector Master Plan

**Durable plan for multi-platform connectors under one agentic control plane.**

Version 1.0 · 3 Aug 2026 · Owner: Vishwas · Status: active engineering plan  
Companion docs: `MASTER-BACKEND-PLAN.md` (parent repo), `docs/AGENT-PLATFORM-PLAN.md`, `docs/PLATFORM-GUIDE.md`, `AGENTS.md`

---

## 1. Vision

Opptra SCM becomes an **agentic workspace** where every marketplace, OMS/WMS, sheet, and courier is a **connector** that exposes typed capabilities over API. Operators and agents invoke actions (`searchOrders`, `downloadReport`, `adjustInventory`, …) with tenant credentials — they do **not** need to click through seller-portal UIs for day-to-day work.

**Auth is per platform:** bearer (UC public API, Amazon SP-API), session cookie (UC internal `/data`, some portals), or OAuth (Google, Flipkart where offered). Credentials live in a vault; every invocation is a **Run** with audit.

**Compile later into one control plane:** today's hard-wired `automation-*` packages and `/api/automations/*` routes become thin playbooks on top of a uniform connector registry. The live app at `scm.opptra.com` keeps working; connectors are additive. Eventually agents compose connectors via tool manifests (see `AGENT-PLATFORM-PLAN.md`); this document owns the **connector layer itself**.

**North star (one sentence):** one URL, one run ledger, many platforms — capabilities callable by humans, Slack ops agents, and (later) LLM planners without portal UI dependency.

---

## 2. Platform matrix

Priority legend: **P0** = build now (foundation), **P1** = next after UC + Sheets stabilize, **P2** = later / access-gated.

| Platform | Auth model | Official API vs session/RPA | Core capabilities to expose | Priority | Risks |
|---|---|---|---|---|---|
| **Unicommerce (OMS/WMS)** | Dual: OAuth password-grant **bearer** (`/oauth/token` → `/services/rest/v1`) + **JSESSIONID** session (`/data/*`); admin paste + keepalive today; scripted login hook reserved | Official public REST + reverse-engineered internal `/data` (975 endpoints in `unicommerce-engine/`). No RPA required for known flows | Orders/SO, allocate, invoice, cancel; inventory snapshot/adjust/ATP; returns/CN; putaway/picklists; shipments/labels; facilities/channels/SKUs; report export jobs | **P0 FIRST BUILD** | Single shared bot session → worker must stay serial for `/data`; facility is session-global; session death ≠ `successful:false`; rate limits; ToS on internal APIs; CAPTCHA when cookie dies |
| **Amazon Seller Central / SP-API** | LWA OAuth (refresh tokens) + AWS SigV4 for SP-API; seller + developer registration | **Official SP-API** (preferred). Seller Central UI only for gap-fill / reports not in SP-API | Orders, inventory/FBA, shipments, feeds, reports, listings (as needed for Opptra ops) | **P1** | Weeks of developer registration + ID verify; app approval; quota; region/marketplace scoping |
| **Flipkart Seller** | Seller API keys / OAuth after seller approval (3–5 days typical) | **Official Seller API** where approved; portal session only if API gaps | Orders, inventory, listings, shipments, returns, ASN-related ops we already emit files for | **P1** | Approval lead time; API surface incompleteness vs portal; rate limits |
| **Myntra Partner** | Partner portal credentials / partner API if granted | Prefer official partner APIs; else constrained session automation | Orders/PO/ASN acceptance paths we already compile ASN files for; inventory where available | **P2** | Partner access gated; ASN file formats already in-repo but portal write-back may be manual |
| **Nykaa** | Seller portal / partner API if available | Likely **session/portal-first** until official access | Orders, inventory, returns (ops-critical subset) | **P2** | Weak/undocumented API; ToS; brittle DOM/session |
| **Zepto** | Seller/vendor portal; ASN already CSV from UC | Portal/session or partner feed; no full public seller API assumed | Orders/PO fulfillment status, inventory, ASN upload companion to our Zepto CSV writer | **P1** (after Sheets) | No stable public API; rate/ToS; format churn |
| **Blinkit** | Seller/vendor portal | Portal/session-first | Orders, inventory, dispatch status | **P1–P2** | Same as other quick-commerce: access + ToS |
| **Swiggy Instamart** | Partner/seller portal | Portal/session-first | Orders, inventory, slot/dispatch signals needed by warehouse ops | **P1–P2** | Same class as Zepto/Blinkit |
| **Google Sheets** | OAuth refresh token (admin connect) and/or SA + DWD; per-user OAuth vault exists | **Official Google Sheets/Drive/Gmail APIs** — first-class | Multiple spreadsheets as named resources: read/write ranges, tab ops, Master/B2B/source sync patterns already in `automation-sheet` | **P0** (immediately after UC scaffold) | Impersonation scope; IMPORTRANGE mirrors must never be overwritten; token revocation |
| **Vinculum / Home Centre** (optional later) | RSA-encrypted login + session | Vendor portal API patterns in `integrations-vinculum` | Order list → UC B2C punch; Vinculum fulfill/label (HAR-configured) | **P2** | Creds often invalid; fulfill actions need HAR capture; GCC-only today |
| **Couriers** (Shiprocket / Delhivery / …) | API keys / OAuth | Official courier aggregator APIs | Tracking, manifest, label fetch | **P2** | Multi-courier mapping; webhook reliability |
| **E-way / GST** | NIC portal / GSP where used; today EWB is **via Unicommerce** (`generateEWayBill`) | Prefer UC path we already prove; direct NIC/GSP only if UC insufficient | Generate/download EWB; GSTIN validation | **P2** (UC path is P0 capability) | Transporter GSTIN must be 15 chars; dry-run mandatory before mutate |

---

## 3. Shared connector architecture

Grounded in what already exists: `@opptra/uc-client`, `@opptra/core` runs/audit, BullMQ worker, Google OAuth vault, dry-run on e-way / Home Centre.

### 3.1 Connector interface

Every connector implements one shape (aligns with `AGENT-PLATFORM-PLAN.md` §3.1):

```ts
Connector = {
  id: string;                 // e.g. 'unicommerce' | 'google-sheets' | 'amazon'
  name: string;
  auth: {
    kind: 'oauth2' | 'apikey' | 'session' | 'bearer' | 'basic' | 'dual';
    // dual = UC bearer + session
  };
  health(): Promise<{ ok: boolean; detail?: object }>;
  listCapabilities(): Capability[];   // static registry + runtime flags
  invoke(action: string, params: object, ctx: InvokeContext): Promise<InvokeResult>;
}
```

- **`InvokeContext`:** tenant/workspace id, vaulted credentials, `runUid`, logger, `dryRun`, optional `approve()` gate.
- **`Capability`:** `{ id, title, mutates, inputSchema, outputSchema, requiresApproval? }`.
- Existing pipelines become **actions** (e.g. `unicommerce.saleOrder.fetch`, `unicommerce.ewaybill.generate`) rather than one-off HTTP routes forever.

### 3.2 Credential vault (per tenant)

| Today | Target |
|---|---|
| UC session singleton in Postgres (`uc_session`) + env override | Still one bot session per workspace for UC (facility mutex); vault row typed `session` |
| Google: shared refresh + `user_google_oauth` | Generalize to `connector_credentials(workspace_id, connector_id, kind, ciphertext, meta)` |
| Vinculum env vars | Vault entry when enabled |
| `OPS_AGENT_TOKEN` | Machine auth to *our* API — not a marketplace credential |

Rules: encrypt at rest; never log cookies/tokens; never commit `.env`; admin paste flows verify before overwrite (already true for UC session paste).

### 3.3 Unified job / run model

**Reuse the existing `runs` table** (`createRun` / `markRunning` / `finishRun` / `pending_retry` / artifacts). Do not invent a second ledger.

- API validates → creates Run → enqueues BullMQ job → **only the worker** talks to external platforms (UC correctness rule from `AGENTS.md`).
- Connector `invoke` inside the worker writes result/error/artifacts on the same Run.
- Idempotency: keep `step_ledger` / `memoStep` for multi-step mutates (inventory inward/outward already does this).

### 3.4 Rate limits, retries, audit

| Concern | Existing pattern | Connector rule |
|---|---|---|
| UC HTTP | `RateLimiter` ~4 rps / burst 8 in `uc-client` | Per-connector limiter; never bypass |
| API flood | Per-user rate limits on automation routes | Keep on `/api/connectors/*` |
| Retries | Idempotent GETs retry; **mutating UC calls never blind-retry** | Same: mutate once; resume via state/`memoStep` |
| Session death | `SessionError` → refresh mutex + one retry | Surface as failed Run if refresh fails; alert Slack |
| Audit | `audit_log` + Run attribution | Log connector id, action, actor, runUid; never secret values |

### 3.5 Dry-run + approve pattern

Proven today:

- E-way: `dryRun: true` validates GSTIN/invoice without calling `generateEWayBill`.
- Packing: draft-first; `sendDraft` only after human review in Gmail.
- Home Centre: dry-run sync/fulfill; empty list is honest success (`empty: true`), not fake progress.
- Return: resumable `pending_retry` when UC state not ready.

**Connector standard:** every mutating capability accepts `dryRun` where meaningful; money/customer-facing actions support `requireApproval` → Run parks (`pending_approval` — new status when agent runtime lands; until then use draft/dry-run + explicit second API call).

---

## 4. Unicommerce complete connector — detailed build plan (FIRST)

### 4.1 Inventory — what already exists in repo

| Asset | Location | What it gives the connector |
|---|---|---|
| **UcClient** | `packages/uc-client` | `public` / `data` / `dataGet` / `dataBinary`; facility switch mutex; bearer + session; rate limit; ping/keepalive |
| **Session paste + verify** | `apps/api` admin routes; Session Helper extension; `docs/SESSION-CAPTURE-OPTIONS.md` | Alive cookie in Postgres; reject bad paste |
| **Keepalive** | Worker job `system.keepalive` | Cheap `/data/user/facilities` ping |
| **Order lookup** | `uc-client/order.js` | `fetchSummary` (facility-agnostic) + facility hop `fetch` for warehouse |
| **ASN compile** | `automation-asn` | SO → Flipkart/Myntra XLSX / Zepto CSV |
| **Packing mail** | `automation-packing` | UC packages + Sheets + Drive + Gmail drafts |
| **Sheet update** | `automation-sheet` | Waypoint Neon + UC invoice enrichment + Master sheet |
| **E-way bill** | `automation-ewaybill` | `generateEWayBill` + PDF download; dry-run |
| **Reverse DC** | `automation-reversedc` | Bulk return → CN PDF → Delivery Challan |
| **Return + redispatch** | `automation-return` | Bulk return create, allocate, invoice, manifest, AWB, cancel |
| **Inward / Outward / Full-cycle** | `automation-inventory` | PO/GRN/putaway/adjust + B2C SO create/allocate/invoice |
| **Home Centre punch** | `automation-homecentre` + `integrations-vinculum` | UC customer + SO create via bearer |
| **Endpoint mine** | `unicommerce-engine/endpoints.json` (**975** paths), `FLOWS.md`, HARs (`oppdoor*.har`, `return-flow.har`, …) | Discovery source for Phase 0 |
| **FMCG daily reports** | `uc-fmcg-daily-reports` (sibling Python) | Inventory datatable + batch details download pattern + GCS session store — port as UC report actions |
| **API surface today** | `/api/automations/*`, `/api/uc-session`, `/api/ops/summary` | Playbook-level; not yet capability registry |

**Hard constraints already encoded (do not violate):**

1. Only the worker process calls Unicommerce.
2. Session death = HTTP 401 / login-redirect / `USER_NOT_LOGGED_IN` only — not `successful:false` or 403.
3. Internal `/data` calls serialized (facility session-global).
4. Every action = a Run row.
5. Mutating UC calls never blind-retry.

### 4.2 Full capability backlog

Group by domain. Status: **Have** = wired in automation/client today; **Partial** = endpoint known / used elsewhere; **Gap** = needs Phase 0–2 work.

#### Auth & health
| Capability | Status | Notes |
|---|---|---|
| Session cookie get/set (admin paste) | Have | Verified paste |
| Bearer OAuth password grant | Have | `BearerManager` |
| Keepalive / health | Have | `uc.ping`, facilities |
| Scripted login | Partial | Hook exists; login HAR not productized |
| Dual-auth health report | Gap | Single `health()` exposing both layers |

#### Orders / sale orders
| Capability | Status | Notes |
|---|---|---|
| Search / list SOs | Gap | Mine from `/data` + public search |
| Get summary | Have | `fetchSummary` |
| Get full DTO (facility hop) | Have | `fetch` + ASN/packing paths |
| Fetch shipping package details | Have | Packing, e-way, sheet, return |
| Fetch invoice details | Have | Sheet, return |
| Create B2C SO | Have | Inventory outward, Home Centre |
| Create B2B SO | Partial | Return channel `CUSTOM_B2B`; FLOWS.md B2B path |
| Allocate inventory (B2C) | Have | `/data/oms/saleorder/allocate/inventory` |
| Allocate B2B smart-fill | Have | Return pipeline |
| Create invoice (package) | Have | Public `shippingPackage/createInvoice` |
| Cancel SO | Have | Return pipeline public cancel |
| Smart-fill details | Have | Return |
| Switch facility (SO) | Partial | Endpoint in engine; not productized as action |

#### Inventory
| Capability | Status | Notes |
|---|---|---|
| Snapshot get | Have | Public `inventorySnapshot/get` |
| Adjust ADD/REMOVE | Have | Inward ADJUST mode |
| Batchwise by SKU | Have | Return B2B allocate |
| Search inventory (datatable/report) | Partial | FMCG script + `/data/reports/searchInventory` |
| Upload / bulk adjust | Gap | Needs proven payload |
| ATP / availability view | Gap | Derive from snapshot + channel rules |

#### Returns / CN
| Capability | Status | Notes |
|---|---|---|
| Bulk return create | Have | Return pipeline |
| Bulk return fetch summary | Have | Reverse DC |
| Reverse pickup search | Partial | Engine endpoint |
| CIR details | Have | Return |
| Credit note / CN PDF download | Have | Reverse DC path |
| Putaway after return | Have | Return + inventory putaway |

#### Reports
| Capability | Status | Notes |
|---|---|---|
| Export job create / poll / download | Partial | Engine: `/data/tasks/export/*`; FMCG uses UI-equivalent pulls |
| Inventory all / shelf-batch CSV | Partial | `uc-fmcg-daily-reports` |
| Batch details (N days) | Partial | FMCG script |
| Major OMS/WMS report types | Gap | Catalog from UC export job types + HAR |
| Datatable views | Partial | Engine endpoints exist |

#### Facilities, channels, SKUs, WMS ops
| Capability | Status | Notes |
|---|---|---|
| List facilities | Have | `listFacilities` |
| Switch facility | Have | Internal to client |
| List / get channels | Partial | Engine `/data/channel/*` |
| Item / SKU search | Partial | `/data/itemTypes/search`, catalog endpoints |
| Putaway create/add/complete | Have | Inventory GRN path |
| Picklists / packlists | Gap | Engine has packer/picker endpoints |
| Shipments: provider allocate, dispatch, mark delivered | Have | Return pipeline |
| Manifest create/add/close | Have | Return |
| Labels / AWB pool | Partial | Staging AWB add; prod courier-dependent |
| E-way generate + PDF | Have | E-way automation |

### 4.3 Phased UC connector delivery

| Phase | Goal | Exit criteria |
|---|---|---|
| **Phase 0 — Discover** | Inventory endpoints from `unicommerce-engine`, live HARs, and every path already called in `packages/**`. Produce `docs/uc-capability-map.md` (action → path → auth layer → facility scope → mutate?) | Map covers backlog rows; gaps labeled; no production deploy required |
| **Phase 1 — Read APIs** | Action registry for all **read** capabilities: health, facilities, SO get/summary/packages/invoices, inventory snapshot, channel/SKU search, report job status | `/api/connectors/unicommerce/invoke` (or `/api/uc/...`) serves reads via worker; tests with mocks; dry-run N/A |
| **Phase 2 — Write / mutate** | Wrap proven mutates: allocate, invoice, cancel, adjust, PO/GRN/putaway, bulk return, e-way (with dry-run), Homecentre SO create | Each mutate has dry-run or idempotent `memoStep`; parity with existing automations; no blind retry |
| **Phase 3 — Reports bulk** | Port FMCG daily reports + generalize export-job download; schedule via BullMQ | GCS/Sheets destinations configurable; facility loop; honest partial failure |
| **Phase 4 — Stable SDK** | `@opptra/connectors-unicommerce` versioned surface; deprecate direct pipeline imports from apps; generate types from capability map; optional MCP expose | Semver; changelog; agent `toolManifest()` ready |

### 4.4 Package layout

```
packages/connectors-unicommerce/
  package.json                 # @opptra/connectors-unicommerce
  src/
    index.js                   # createUnicommerceConnector(ucClient, opts)
    connector.js               # health, listCapabilities, invoke
    registry.js                # action id → handler
    actions/
      auth.js                  # health, session status (no secret leak)
      orders.js                # fetch, summary, search, create, allocate, invoice, cancel
      inventory.js             # snapshot, adjust, batchwise, search
      returns.js               # bulk return, CN
      reports.js               # export jobs, inventory/batch downloads
      facilities.js            # list, (switch internal)
      channels.js
      skus.js
      wms.js                   # putaway, pick/pack, shipment, labels
      ewaybill.js              # thin wrap of automation-ewaybill or inlined
    schemas/                   # JSON Schema / zod per action
  test/
```

**Bridge, don't rewrite:** Phase 1–2 handlers call existing `UcClient` and, where useful, existing pipeline functions. `automation-*` remain playbooks that call the connector (or share the same action modules).

`packages/uc-client` stays the **transport** (session/bearer/facility/rate-limit). The connector is the **capability layer** on top.

### 4.5 API surface on scm.opptra.com

Prefer a clear dual path during migration:

| Route | Purpose |
|---|---|
| `GET /api/connectors` | List registered connectors + health summary |
| `GET /api/connectors/unicommerce/capabilities` | `listCapabilities()` |
| `GET /api/connectors/unicommerce/health` | Dual-auth health (no secrets) |
| `POST /api/connectors/unicommerce/invoke` | `{ action, params, dryRun? }` → create Run → enqueue → `{ runUid }` |
| `GET /api/runs/:runUid` | Existing run poll |

**Alias (ergonomic):** `POST /api/uc/:action` → same invoke handler for the highest-traffic actions (e.g. `/api/uc/saleOrder.get`).

**Keep** `/api/automations/*` until each playbook is re-homed; they become wrappers that call connector actions. **Keep** `/api/ops/summary` for Slack/Cursor agents (no SSO).

Auth: Google SSO for humans (`admin`/`ops`); `OPS_AGENT_TOKEN` only for ops summary unless explicitly extended later.

---

## 5. Sequencing

Order is **access difficulty × ops value**, with UC as the capability spine everything else talks to.

| Window | Focus | Outcome |
|---|---|---|
| **Week 1–2** | UC Phase 0 map + **connector scaffold PR** (this plan's immediate task) | Package + registry + health + 3–5 read actions + invoke route behind worker |
| **Week 3–4** | UC Phase 1 reads complete; start **Google Sheets connector** (promote `integrations-google` + multi-spreadsheet resource ids) | Sheets as first-class connector; Master/B2B as named resources |
| **Week 5–6** | UC Phase 2 mutates (wrap existing automations as actions); dry-run/approve consistency | Automations call connector actions internally |
| **Week 7–8** | UC Phase 3 reports (port FMCG patterns); Sheets scheduled pulls | Daily inventory/batch via connector jobs |
| **Week 9–12** | **Flipkart + Amazon** paperwork (start earlier if not started) + thin read connectors as access lands | Orders/inventory reads into Runs |
| **Week 13–16** | **Quick commerce:** Zepto → Blinkit → Swiggy Instamart (portal/session where needed; ASN companions first) | Ops-critical subset only |
| **After** | Myntra Partner, Nykaa, Vinculum/HC polish, couriers, direct e-way/GST | P2 backlog |
| **Ongoing** | Agent runtime (`AGENT-PLATFORM-PLAN`) consumes connector `toolManifest()` | Control plane compile — not a blocker for connector SDK |

**Rule:** each window leaves production automations green. No big-bang cutover. No deploy from this plan doc alone.

---

## 6. Non-goals / safety

1. **No fake success.** Empty lists, `configured: false`, dry-run previews, and partial failures must be explicit in Run results (Home Centre pattern is the template). Never mark a Run succeeded when the platform call did not happen.
2. **No secrets in git.** `.env`, JSESSIONID, OAuth refresh tokens, `OPS_AGENT_TOKEN`, Vinculum passwords stay on VM/secrets only. Docs show placeholders only.
3. **Session security.** Cookies httpOnly on UC side; we store encrypted/server-side only; admin paste verifies before overwrite; never return raw JSESSIONID from `/api/ops/summary` or health endpoints.
4. **Respect ToS and rate limits.** Prefer official APIs. Internal UC `/data` and seller-portal session automation are **ops-owned**, rate-limited, and minimized — not scraped aggressively. Portals without official API: read-mostly first; mutates only with explicit approval.
5. **No second worker talking to UC** until a second whitelisted bot account exists.
6. **No Playwright CAPTCHA bypass.** Human solves CAPTCHA (paste, extension, or future remote browser — `SESSION-CAPTURE-OPTIONS.md`).
7. **Master sheet IMPORTRANGE mirrors** are never overwritten (existing sheet pipeline rule).
8. **Do not break production.** Scaffold and new routes ship behind tests; deploy only with explicit human approve per `AGENTS.md`.

---

## 7. Immediate next engineering task

**First PR after this plan: Unicommerce connector scaffold** (docs-only PR is this file; next is code).

### Scope (concrete)

1. Create `packages/connectors-unicommerce` with:
   - `createUnicommerceConnector({ uc })`
   - `health()`, `listCapabilities()`, `invoke(action, params, ctx)`
   - Initial actions (read-only): `health.ping`, `facilities.list`, `saleOrder.getSummary`, `saleOrder.get` (facility hop via existing order lookup), `inventory.snapshot`
2. Register connector in API:
   - `GET /api/connectors/unicommerce/capabilities`
   - `GET /api/connectors/unicommerce/health`
   - `POST /api/connectors/unicommerce/invoke` → `createRun` + enqueue `connector.unicommerce.invoke`
3. Worker handler `connector.unicommerce.invoke` that calls the package and `finishRun`.
4. Unit tests with mocked `UcClient` (mirror `uc-client` / handlers test style).
5. Do **not** remove `/api/automations/*`; do **not** deploy without human approve.

### Out of scope for first PR

Mutating actions, report bulk port, MCP, LLM agent loop, multi-tenant vault migration, marketplace connectors.

### Acceptance

- `npm` workspace tests pass for the new package + API/worker route tests.
- Invoke of `saleOrder.getSummary` with a mocked UC client returns structured result on a Run.
- Health endpoint never returns cookie/token material.
- Capability list documents `mutates: false` for all Phase-1 actions.

---

## 8. Traceability

| Plan claim | Code / doc evidence |
|---|---|
| Dual UC auth | `uc-client` `public` + `data`, `bearer.js`, `session.js` |
| 975 endpoints | `unicommerce-engine/endpoints.json` |
| Proven flows | `unicommerce-engine/FLOWS.md` |
| Runs ledger | `packages/core/src/runs.js` |
| Dry-run | `automation-ewaybill`, Home Centre routes |
| Session paste | `apps/api` admin UC session + `SESSION-CAPTURE-OPTIONS.md` |
| FMCG reports | `uc-fmcg-daily-reports/README.md` |
| Agent vision | `docs/AGENT-PLATFORM-PLAN.md` |
| Ops constraints | `AGENTS.md`, `PLATFORM-GUIDE.md` |

---

*End of Connector Master Plan v1.0 — update this file when platform priorities or UC capability map change; do not fork into chat-only plans.*
