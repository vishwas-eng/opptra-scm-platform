# Reverse-Engineering Playbook

**Repeatable recipe:** portal login → HAR → typed connector actions → session vault → health/keepalive → fixtures → (later) official API swap.

Version 1.0 · 3 Aug 2026 · Companion: `docs/CONNECTOR-MASTER-PLAN.md` §0 Doctrine

Unicommerce is the **reference implementation**. Every new seller portal (Amazon, Flipkart, Myntra, Nykaa, Zepto, Blinkit, Instamart, …) follows this same loop. Google Sheets is **hybrid** — OAuth/official already; skip RE unless a UI-only gap appears.

---

## 0. Mindset

| Do | Don’t |
|---|---|
| Capture real browser XHR/fetch the ops team already uses | Wait for partner API keys before shipping |
| Name capabilities by **business intent** (`orders.search`) | Name actions after URL path fragments forever |
| Store cookies/tokens only in the vault | Commit HARs with live cookies/tokens |
| Rate-limit and serialize session-scoped calls | Fire concurrent facility/session mutations |
| Keep the same `invoke(action, …)` when swapping to official API | Fork a second connector id for “the API version” |

---

## 1. Login + DevTools Network capture (HAR)

1. Log into the seller/ops portal as the **bot / shared ops account** (same account you will vault).
2. Open DevTools → **Network**. Enable **Preserve log**. Filter `Fetch/XHR`.
3. Perform the ops flows you need (see portal backlog below). Prefer the exact clicks operators use daily.
4. Export **HAR** (or copy cURL for each critical call). Prefer one HAR per flow: `orders.har`, `inventory.har`, `labels.har`, `returns.har`.
5. Immediately **sanitize** before anything hits git:
   - Strip `Cookie`, `Authorization`, CSRF tokens, refresh tokens, account ids if sensitive.
   - Keep URL, method, query, body **shape**, response **shape**, and header **names** (values → placeholders).

**UC reference:** sibling repo HARs + `unicommerce-engine/` (`FLOWS.md`, `endpoints.json`). Session ingest: `docs/SESSION-CAPTURE-OPTIONS.md`, admin paste `POST /api/admin/uc-session`, helper extension ingest.

---

## 2. Identify cookie / header / CSRF / token patterns

For each portal, fill a short auth card:

| Field | Example (UC) | What to find |
|---|---|---|
| Session cookie name | `JSESSIONID` | Which cookie(s) the XHR sends |
| How cookie is obtained | Admin paste / extension / remote browser | Human CAPTCHA allowed; no bypass |
| Extra headers | (UC public uses `Authorization: bearer …` + `Facility`) | CSRF, `x-*,` marketplace ids |
| Token refresh | UC: bearer password-grant; session: paste + keepalive | Is there a silent refresh XHR? |
| Death signals | HTTP 401/302, `USER_NOT_LOGGED_IN` | What is **not** death (UC: `successful:false`, 403) |
| Scope quirks | Facility is session-global on `/data` | Warehouse/channel headers that must serialize |

Implement auth only as a **session manager** (get cookie → attach → mark alive/dead → alert), mirroring:

- `packages/uc-client/src/session.js`
- `packages/uc-client/src/bearer.js`
- `packages/uc-client/src/client.js` (`ping`, mutex, facility switch)

Do **not** invent a parallel vault for a portal that already has one.

---

## 3. Catalog actions (method, URL, body, response shape)

For every XHR worth automating, add one catalog row:

| action id | method | path | auth | mutates? | request body (shape) | response (shape) | notes |
|---|---|---|---|---|---|---|---|
| `saleOrder.getSummary` | POST | `/data/oms/saleorder/fetchSummary` | session | no | `{ code }` | `{ saleOrderSummary }` | facility-agnostic |
| `inventory.snapshot` | POST | `/services/rest/v1/inventory/inventorySnapshot/get` | bearer | no | `{ itemTypeSKUs }` | `{ inventorySnapshots }` | idempotent |

**Rules:**

- Prefer **read** actions first (orders, inventory, labels download URL, returns list).
- One capability = one operator intent. Compose multi-step flows in playbooks/automations, not as mega-actions (unless the portal itself is one atomic POST).
- Mark facility/channel scope and rate-limit needs.

**UC reference catalog sources:**

- Live calls already in `packages/automation-*` and `packages/uc-client`
- Sibling `unicommerce-engine/endpoints.json` (975 paths), `FLOWS.md`, `ENDPOINTS.md`

---

## 4. Implement connector action + session vault

### Package shape (copy UC)

```
packages/connectors-<portal>/
  src/
    index.js          # createXxxConnector({ client })
    connector.js      # health, listCapabilities, invoke
    registry.js       # action id → { meta, handler }  ← easy HAR adds
    actions/*.js      # thin wrappers over transport client
  test/
    connector.test.js # mocked transport + fixtures
```

### Registry pattern (HAR → one PR)

```js
// registry.js — adding a newly discovered endpoint:
register({
  id: 'orders.get',
  title: 'Get order',
  mutates: false,
  backend: 're',          // later flip handler to 'official' without renaming id
  inputSchema: { /* … */ },
  handler: actions.getOrder,
});
```

### Transport vs capability

| Layer | UC file | Responsibility |
|---|---|---|
| Transport | `packages/uc-client` | HTTP, cookies, rate limit, facility mutex, death/retry |
| Capability | `packages/connectors-unicommerce` | Named actions, schemas, `invoke` |
| Playbook | `packages/automation-*` | Multi-step ops (packing, e-way, return, …) |
| API | `apps/api` routes | Auth → `createRun` → enqueue |
| Worker | `apps/worker` | **Only** process that talks to the portal |

### Session vault

- Persist cookie/token server-side (UC: `uc_session` table).
- Admin paste **verifies** before overwrite (see `apps/api/src/routes/admin.js`).
- Never return raw secrets from health/ops endpoints.

---

## 5. Health check + keepalive

1. **`health.ping` (or equivalent):** cheapest authenticated read (UC: `GET /data/user/facilities` via `uc.ping()`).
2. **Keepalive job:** BullMQ scheduler on an interval (UC: `system.keepalive` in `apps/worker/src/worker.js`).
3. **On death:** alert + `needs_relogin`; human paste/extension/remote browser — no CAPTCHA bypass.
4. **API health route:** may return vault **metadata** only (`has_cookie`, `status`, `last_ok_at`). Live probe goes through the worker via `invoke`.

---

## 6. Tests with recorded fixtures (sanitize secrets)

1. Save sanitized request/response JSON under `packages/connectors-<portal>/test/fixtures/`.
2. Mock the transport client (don’t hit the live portal in unit tests).
3. Assert:
   - capability list marks `mutates` correctly
   - handler maps fixture → stable output shape
   - health/ops paths never echo cookies/tokens
4. Optional: one staging integration test behind env flag.

**UC reference tests:** `packages/uc-client/test/`, `packages/connectors-unicommerce/test/`, automation package tests with fake `uc.data` / `uc.public`.

---

## 7. Later: swap to official API behind the same action name

When keys arrive:

1. Implement `handlersOfficial.orders.search` using SP-API / Seller API / etc.
2. Register it under the **same** `id: 'orders.search'`.
3. Feature-flag or vault `kind` selects RE vs official.
4. Keep Run ledger, API routes, and agent tool names unchanged.
5. Retire RE only when parity is proven — don’t big-bang delete HARs/fixtures.

Sheets already live at step 7 (OAuth). Marketplaces start at steps 1–6.

---

## Portal reverse backlog — what to capture first

After Unicommerce, capture in this order. Each: **login/session** + the four flows.

| Order | Portal | Auth posture | Capture first |
|---|---|---|---|
| 0 | Unicommerce | Session/RE primary (+ bearer dual) | Done — extend from engine + live HARs |
| 1 | Google Sheets | **Official OAuth (hybrid)** | Skip RE; resource-id connector next |
| 2 | Amazon Seller Central | Session/RE primary; SP-API future swap | Orders → inventory → labels → returns |
| 3 | Flipkart Seller | Session/RE primary; Seller API future swap | Orders → inventory → labels/shipments → returns |
| 4 | Zepto | Session/RE primary | PO/orders → inventory → ASN/label upload → returns |
| 5 | Blinkit | Session/RE primary | Orders → inventory → dispatch/labels → returns |
| 6 | Swiggy Instamart | Session/RE primary | Orders → inventory → slot/dispatch → returns |
| 7 | Myntra Partner | Session/RE primary | Orders/PO → inventory → ASN acceptance → returns |
| 8 | Nykaa | Session/RE primary | Orders → inventory → labels → returns |

### Handoff checklist (what to send the engineer)

For the **next** portal after UC (usually **Amazon** once UC scaffold is green):

- [ ] Sanitized HAR(s) for orders, inventory, labels, returns
- [ ] Cookie/header names + death signals notes (screenshot ok)
- [ ] Bot account username (password → vault only, never chat/git)
- [ ] Which warehouse/marketplace account the capture used
- [ ] Any CAPTCHA / 2FA pattern (human-in-the-loop expectation)

---

## Unicommerce reference map (real files)

| Concern | Path |
|---|---|
| Doctrine / matrix | `docs/CONNECTOR-MASTER-PLAN.md` |
| Session capture options | `docs/SESSION-CAPTURE-OPTIONS.md` |
| Transport client | `packages/uc-client/src/client.js` |
| Session + bearer | `packages/uc-client/src/session.js`, `bearer.js` |
| Order RE helpers | `packages/uc-client/src/order.js` |
| Connector (RE capability layer) | `packages/connectors-unicommerce/` |
| Admin session paste | `apps/api/src/routes/admin.js` |
| Keepalive | `apps/worker/src/worker.js` (`system.keepalive`) |
| Endpoint mine (sibling) | `../unicommerce-engine/` (`endpoints.json`, `FLOWS.md`) |
| Proven playbooks | `packages/automation-{packing,sheet,ewaybill,return,inventory,asn,reversedc,homecentre}` |

---

*End of Reverse-Engineering Playbook v1.0 — keep this procedural; put platform priorities in the master plan.*
