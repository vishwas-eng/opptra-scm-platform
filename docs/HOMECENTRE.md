# Home Centre (Vinculum) — GCC

Scheduled + manual automation on `scm.opptra.com` under the **GCC** region toggle.

## Split targets (important)

| Flow | Source | Destination | Gate |
|------|--------|-------------|------|
| **Orders** | Vinculum HC active orders | **UC Staging** (`oppdoorstg`) by default | `HC_ORDERS_UC_TARGET=staging`, `HC_DRY_RUN=false` to write. UAE SO only when `HC_ORDERS_UC_TARGET=uae` **and** `HC_LIVE=true` |
| **Inventory** | Vinculum seller SKU list + **UAE UC** qty | Vinculum Update Pricing & Inventory upload | Preview/dry-run fill always; **upload** only when `HC_LIVE=true` |

Sessions are **per UC instance** (`india` / `uae` / `ksa` / `staging`) — see `docs/UC-SESSIONS.md`. India packing never shares a JSESSIONID with staging/UAE/KSA. HC writes use staging/UAE **OAuth** with dedicated bots (`HC_UC_STAGING_*` / `HC_UC_UAE_*` or `UC_UAE_*`) — never the India `UC_USER` bot.

Intended GCC identities (DLs): UAE `scuae.automations@opptra.com`, KSA `scksa.automations@opptra.com`. India remains `sc.automations@opptra.com` only. A DL cannot log into UC by itself — need a UC user with that username + password, or Admin session paste from a real user on that tenant (env `*_USER` still set to the DL for labeling). FZE `scfze.automations@opptra.com` is planned; no UC host wired yet.

Owner: `HC_OWNER_EMAIL=ratikanta@opptra.com` (personal today; regional DLs may become status To: later — see `docs/UC-SESSIONS.md`).

**Out of scope:** Vinculum invoice / transporter / acceptance / fulfill.

## Inventory process (correct)

```
1. Download seller SKU list from Vinculum (jsonSellerSkuEnqBS, vendorCode = VINCULUM_USER)
2. Pull inventorySnapshot from UAE UC (facility HC_UC_UAE_INV_FACILITY=opptrauae)
3. Fill import rows: MarketPlace SkuCode = mrktSku, Vendor Sku = skuCode, Seller Inv = UC qty
4. Upload xlsx only when HC_LIVE=true
```

Do **not** drive inventory from archive order `LAND*` codes. Those are order marketplace IDs; the seller catalogue uses seller `skuCode` (e.g. `T80358`) which is **identical** to UAE UC `skuCode` (151/151, 2026-08-04). Blank `sellerSkuImportDisplayDownloadImportTemplateBS` is only a format sample — live rows come from the seller SKU list.

| Match field | Rate (OppDoor UAE, n=151) |
|-------------|---------------------------|
| Vinculum `skuCode` ↔ UC `skuCode` (catalog) | **100%** (151/151) |
| Inventory rows at facility `opptrauae` | **~81%** (122/151); rest fill as qty 0 |
| Vinculum ISBN ↔ UC scanIdentifier | **0%** (different barcodes) |
| Archive `LAND*` ↔ UC | **0%** (wrong universe — order IDs, not seller list) |

Inventory stock for these SKUs is on facility **`opptrauae`**. `OPP_RFS_FZ_UAE` is a valid session facility but returns empty snapshots for the Tower set.

`HC_SKU_MAP_JSON` is **optional** while identity holds — do not invent a LAND* map.

## Safety defaults

```
HC_LIVE=false
HC_DRY_RUN=true
HC_ORDERS_UC_TARGET=staging
```

## Env (VM `.env` only — never git)

```
VINCULUM_BASE_URL=https://landmarkgroup.vinsupplier.com/eRetailWeb
VINCULUM_USER=…          # also used as vendorCode for seller SKU list (e.g. 2424675)
VINCULUM_PASS=…

# Orders → staging UC
HC_UC_STAGING_BASE_URL=https://oppdoorstg.unicommerce.com
HC_UC_STAGING_USER=…
HC_UC_STAGING_PASS=…
HC_UC_STAGING_FACILITY=oppdoorstg
HC_UC_STAGING_CHANNEL=CUSTOM
HC_UC_STAGING_CUSTOMER=OPPB2B01
HC_STAGING_SKU_FALLBACK=optest

# Inventory ← UAE UC (company code opptrauae — NOT oppdooruae)
HC_UC_UAE_BASE_URL=https://opptrauae.unicommerce.com
HC_UC_UAE_USER=…
HC_UC_UAE_PASS=…
HC_UC_UAE_FACILITY=OPP_RFS_FZ_UAE
HC_UC_UAE_INV_FACILITY=opptrauae
HC_UC_UAE_CHANNEL=Home Centre B2C
HC_VINCULUM_VENDOR_CODE=     # empty → VINCULUM_USER
HC_SELLER_CODE_UAE=          # empty → sellerCode from downloaded list
# HC_SKU_MAP_JSON=           # optional overrides only

HC_OWNER_EMAIL=ratikanta@opptra.com
HC_SYNC_MINUTES=30
HC_LIVE=false
HC_DRY_RUN=true
HC_ORDERS_UC_TARGET=staging
```

## Staging SO test (manual)

1. Set **dedicated** staging creds (`HC_UC_STAGING_USER` / `HC_UC_STAGING_PASS`) — never India `UC_USER` / `sc.automations`. UAE inventory needs `HC_UC_UAE_*` or `UC_UAE_*` (identity `scuae.automations@opptra.com`; DL needs UC user or session paste — see `docs/UC-SESSIONS.md`). Paste sessions per `instance_id` in Admin when using cookie auth.
2. `HC_DRY_RUN=false`, `HC_LIVE=false`, `HC_ORDERS_UC_TARGET=staging`.
3. GCC → Home Centre → uncheck Dry run → **Sync orders → staging UC**  
   (or `source=archive` via API if active list is empty).
4. Confirm SO codes `HC-<webOrderNo>` on staging; no customer create (uses `HC_UC_STAGING_CUSTOMER`).

## Flip orders to UAE later

```
HC_ORDERS_UC_TARGET=uae
HC_LIVE=true
HC_DRY_RUN=false
# + HC_UC_UAE_* + HC_UC_UAE_CUSTOMER + channel Home Centre B2C
```

## Schedule

`HC_SYNC_MINUTES>0` registers BullMQ `homecentre-sync` → `homecentre.scheduled` (inventory + orders). Status: Home Centre tab + `/api/automations/homecentre/status`.

## Current VM status (ops)

Verified **2026-08-04** on `opptra-scm` (UAE/KSA sessions alive; India untouched):

| Item | Status |
|------|--------|
| Vinculum login | **Working** (active=0; archive≈147 / 99 unique `LAND*` order SKUs; **seller list 151** OppDoor SKUs via vendorCode=`VINCULUM_USER`) |
| Staging OAuth (`oppdoorstg`) | **Working** via `HC_UC_STAGING_*`. Vault cookie for `staging` still empty (bearer-only). |
| Staging SO | **Proven** — `HC-94182926180-1` already on staging |
| UAE OAuth (`opptrauae`) | **Working** + session vault `alive` @ `OPP_RFS_FZ_UAE` |
| HC inventory | **Download → merge → dry-run fill** path; identity **151/151** on `skuCode`; stock @ `opptrauae`. Upload gated by `HC_LIVE` (keep false until approved) |
| KSA OAuth (`opptraksa`) | **Working** + session `alive` @ `OPP_SLS_ML_KSA` |
| India session | Independent; vault `alive` — not overwritten |
| Out of scope | Invoice / transporter / acceptance / fulfill |

### Remaining blockers for live upload

1. User approval to set `HC_LIVE=true`
2. Confirm `HC_UC_UAE_INV_FACILITY=opptrauae` on VM `.env`
3. Spot-check dry-run fill qtys vs Vinculum portal before first live upload
4. Deploy updated `automation-homecentre` + `integrations-vinculum` packages to VM

See `docs/UC-SESSIONS.md` access matrix.
