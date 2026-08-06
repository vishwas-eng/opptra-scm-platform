# Unicommerce connector, RE-native reference (the pattern every portal copies)

**Status: LIVE** · Auth: dual, session/RE primary (JSESSIONID `/data/*`), bearer for proven public REST
Package: `@opptra/connectors-unicommerce` (capability layer) on `@opptra/uc-client` (transport).
Evidence base: sibling `unicommerce-engine/` (975 mined endpoints, `ENDPOINTS.md`, `endpoints.json`, `FLOWS.md` with 7 live-proven flows) + production `uc-fmcg-daily-reports`.

## Base URLs & auth layers

| Layer | Base | Auth | Facility scoping |
|---|---|---|---|
| Internal (RE, primary) | `https://oppdoor.unicommerce.co.in/data/*` | `Cookie: JSESSIONID=…` (admin paste → `uc_session` vault, keepalive ping) | **session-global**, client serializes all `/data` calls behind a mutex and switches facility before the call |
| Public REST | `https://oppdoor.unicommerce.co.in/services/rest/v1/*` | `Authorization: bearer <token>` (`/oauth/token?grant_type=password…`, ~1 h TTL) | stateless `Facility: <code>` header per call |

**Facility-switch gotcha:** `POST /data/user/switchfacility` can return `successful:true` while leaving you on a different facility (no access). The client re-pings and asserts `currentFacilityCode` matches.

## Session death, the ONLY three signals

1. HTTP **401** (also 301/302 to a login URL, requires `redirect: manual`)
2. Redirect `Location` containing `login`/`signin`
3. Body containing **`USER_NOT_LOGGED_IN`** (HTTP 200 + JSON error, the sneaky one)

`successful:false` and plain 403 are **business errors, not session death** (hard platform rule). Death triggers one mutexed refresh + one retry inside `uc-client`; a second failure surfaces as a failed Run + Slack alert. Never re-login the bot user in a browser while the platform holds a session, a second login can kill the cookie; refresh by pasting.

## Registered actions (invoke via `POST /api/connectors/unicommerce/invoke` or Agent tools)

Read (mutates:false):

| Action | Endpoint | Layer | Proof |
|---|---|---|---|
| `health.ping` | `GET /data/user/facilities` | session | production keepalive |
| `facilities.list` | `GET /data/user/facilities` | session | production |
| `channels.list` | `POST /data/channel/getChannels {}` | session | mined |
| `saleOrder.getSummary` | `POST /data/oms/saleorder/fetchSummary {code}` | session (facility-agnostic) | HAR + production |
| `saleOrder.get` | summary + facility hop fetch | session | production |
| `saleOrder.getShippingPackages` | `POST /data/oms/saleorder/fetchShippingPackageDetails {saleOrderCode}` | session (facility) | HAR + production |
| `saleOrder.getInvoiceDetails` | `POST /data/oms/saleorder/fetchInvoiceDetails {saleOrderCode}` → `invoices[]` (incl. ISR credit notes) | session (facility) | HAR + Sheet/Return pipelines |
| `saleOrder.getLineItems` | `POST /data/oms/saleorder/fetchLineItems {code}` | session (facility) | HAR |
| `inventory.snapshot` | `POST /services/rest/v1/inventory/inventorySnapshot/get {itemTypeSKUs}` | bearer | flow-proven |
| `inventory.batchwise` | `GET /data/wms/inventory/batchwise?skuCode=` → shelf/batch availability | session | flow-proven (feeds B2B smart-fill) |
| `shipments.search` | `POST /data/tasks/export/data` name=`DATATABLE SHIPMENTS TAB`, filters: `statusFilter` (15-status enum), `createdDateRangeFilter {textRange}`, paging `start/noOfResults` | session (facility) | **HAR body verbatim** (columns list captured live) |
| `returns.bulkReturnSummary` | `POST /data/oms/returns/reversePickup/bulkReturn/fetchSummary {bulkReturnId}` | session | Reverse DC uses it |
| `reports.exportTypes` | `GET /data/tasks/export/configs` | session | mined + FMCG |
| `reports.exportConfigGet` | `GET /data/tasks/export/config/get?exportConfigName=` | session | production (FMCG) |
| `reports.exportJobsList` | `GET /data/user/exportJobs`, poll; terminal OK `COMPLETE/COMPLETED/SUCCESS`, fail `FAILED/ERROR/CANCELLED` | session | production (FMCG) |

**Report export contract** (`reports.exportJobCreate`, listed in the write surface below):
the field is **`exportColums`**, Unicommerce's own typo and the required spelling.
`frequency: ONETIME`; columns default to every exportable column from the config.
Known-good report types: `DATATABLE SEARCH INVENTORY` (full snapshot when no filters) and
`Batch Details` (≤90-day range). A successful job with `exportCount: 0` has **no**
`exportFilePath`, that is an empty report, not a failure. Download is a plain GET on
`exportFilePath` with the session cookie.

**Still on `automation-*` packages, not yet connector actions:** e-way bill
(`generateEWayBill` for first-time generation, `regenerate` only for an invoice that
already has one) + PDF download, PO/GRN inward, and the ASN file writers.


## Write surface (14 mutating actions, all dry-runnable)

Every payload below is copied from code that has run against real Unicommerce and been
verified by a document code or an inventory delta. Nothing here is inferred from an
endpoint name.

| Action | Endpoint | Layer | Notes |
|---|---|---|---|
| `saleOrder.allocateB2C` | `POST /data/oms/saleorder/allocate/inventory` | session | Synchronous → returns `shippingPackageCodes`. Proven: OPPD00149 |
| `saleOrder.allocateB2B` | `POST /data/wms/b2b/sale-order/smart-fill/orders/allocate` | session | **Async.** `inventoryLocationData` (shelf) is REQUIRED, without it UC returns 200 and allocates nothing. Connector resolves the shelf via `batchwise` and **refuses** if none exists. Poll `saleOrder.getShippingPackages`. Proven: OPPD00150 |
| `shippingPackage.createInvoice` | `POST /services/rest/v1/oms/shippingPackage/createInvoice` | bearer | → `invoiceCode`, moves package to PACKED. Proven: INS0109/INS0110 |
| `shipment.allocateProvider` | `POST /data/oms/shipment/provider/allocate` | session | Assigns `trackingNumber` from the courier pool |
| `shipment.dispatch` | `POST /data/oms/shipment/dispatch` | session | Direct path only, in the manifest flow, `manifest.close` is what dispatches |
| `shipment.markDelivered` | `POST /data/oms/shipment/markDelivered` | session | Required before a customer return can be raised |
| `manifest.create` | `POST /services/rest/v1/oms/shippingManifest/create` | bearer | → `shippingManifestCode` |
| `manifest.addPackages` | `POST /services/rest/v1/oms/shippingManifest/addShippingPackage` | bearer | Max 200 per call |
| `manifest.close` | `POST /services/rest/v1/oms/shippingManifest/close` | bearer | **This is what dispatches.** Irreversible. Proven: SM0080/81/87/89 → DELIVERED |
| `returns.bulkReturnCreate` | `POST /data/oms/returns/reversePickup/bulkReturn/create` | session | Order must be DELIVERED. ISR credit note auto-created (read via `saleOrder.getInvoiceDetails`). Stock is NOT sellable until putaway. Proven: ISR0051, inventory +1 |
| `putaway.complete` | `createPutawayList` then `POST /data/putaway/complete` | session | Order matters. This is what returns stock to sellable |
| `inventory.adjust` | `POST /data/inflow/inventory/adjust` | session | ADD / REMOVE, one sku+shelf per call |
| `saleOrder.cancel` | `POST /services/rest/v1/oms/saleOrder/cancel` | bearer | Irreversible |
| `reports.exportJobCreate` | `POST /data/tasks/export/job/create` | session | `exportColums` (sic) |

### Safety rules enforced in code, not convention

1. **`dryRun` on every mutate**, returns the exact request body without sending it. Test-asserted across all 14; a new mutating action without a dry-run fixture fails the suite.
2. **Params validated before anything leaves the process**, `inputSchema` is ajv-compiled and enforced in `invoke()`. Invalid input returns `INVALID_INPUT` and makes zero upstream calls. A dry-run of invalid params reports the validation error rather than previewing an impossible call.
3. **Facility is mandatory and explicit** on every mutate. `/data/*` facility is session-global on a concurrency-1 worker, so an action that guesses it would corrupt the next job's context.
4. **`successful: false` throws**, a business failure can never be reported as success. It is *not* session death (that is 401 / login redirect / `USER_NOT_LOGGED_IN` only).
5. **No blind retry.** Idempotent GETs retry inside `uc-client`; a failed mutate stays failed and surfaces.

### The two flows worth knowing

**Outward B2B:** `saleOrder.allocateB2B` → poll `saleOrder.getShippingPackages` → `shippingPackage.createInvoice` → `shipment.allocateProvider` → `manifest.create` → `manifest.addPackages` → `manifest.close` *(dispatches)* → `shipment.markDelivered`.

**Return + credit note:** order DELIVERED → `returns.bulkReturnCreate` *(CN auto-created)* → `saleOrder.getInvoiceDetails` *(read the ISR code)* → `putaway.complete` *(stock becomes sellable)*.

## Correctness rules (encoded, do not violate)

1. Only the **worker** calls UC. API enqueues `connector.unicommerce.invoke` → Run → poll.
2. Playbooks running **inside** the worker call the connector directly (enqueueing there would deadlock the concurrency-1 queue).
3. Rate limit ~4 rps / burst 8 shared across all UC traffic; 429 honors Retry-After.
4. Mutating calls never blind-retry; multi-step mutates resume via `memoStep`.
5. Health endpoints never return cookie/bearer material (test-enforced).

## Adding an endpoint from a new HAR

One `register({ id, title, mutates, inputSchema, handler })` in `packages/connectors-unicommerce/src/actions*.js`, see `REVERSE-ENGINEERING-PLAYBOOK.md` for the HAR → action recipe. Capability ids stay stable if an official API later replaces the RE handler.
