# 6th Street API reverse notes (2026-08-04)

## VPN reality
- `10.61.1.11` is a **private** Forti/SSL VPN address — **not reachable** from the public internet or the GCP app VM.
- Installing `openfortivpn` and pointing it at `10.61.1.11` fails (no route). FortiClient profile name `6thStreet-OMS` / user `OMS999` still needs the **public SSL VPN hostname** (ask Daniyal/IT), or Path B (human on VPN).
- Long-term: site-to-site from GCP → `10.61.1.11` network.

## Public seller portal (NO VPN required)
| Piece | Value |
|-------|--------|
| UI | `https://seller-portal.6thstreet.com/` |
| Backend `BASE_URL` | from `https://seller-portal.6thstreet.com/assets/.env` → `https://prod-seller-portal-backend.6thstreet.com/sellerportal/` |
| Sample inventory CSV | S3 `…/Sample_inventory_file.csv` (`Sku,Count`) |
| Sample pricing CSV | S3 `…/Sample_pricing_file.csv` |

### Auth (Bearer JWT)
- `POST {BASE}api/public/login` body `{ "username", "password" }` → `accessToken`, `refreshToken`
- `POST {BASE}api/public/refreshToken`
- `GET  {BASE}api/public/users/profile`

### Inventory / pricing (this portal)
- `GET  api/inventory/live`
- `POST api/inventory/upload`
- `GET  api/inventory/imports?start=&limit=`
- `GET  api/inventory/import-items/{id}…` + `/download`
- `GET  api/price/live?country=`
- `POST api/price/upload`
- price import-items + download (mirror of inventory)

### NOT on seller portal Flutter app
Pick list Excel, invoice PDF, shipping label — **absent** from `main.dart.js` API surface. Those come from **IBM OMS** (`apg-oms.prod.coc.ibmcloud.com`), which is VPN-gated (invoice PDF footer confirms Store Engagement home URL).

## Login probe
Portal login with `STREET6_PORTAL_USER=daniyal@opptra.com` returned **`Incorrect username or password`** (HTTP 500 body) on 2026-08-04 from GCP VM — still needs reset/confirm from Daniyal. Do not keep retrying guesses.

## UC instance for inventory
Invoice sample SKU **`5056791600146`** resolves on **KSA** UC (`opptraksa`, facility `OPP_SLS_ML_KSA`) as French Connection candle — EAN==SKU. Prefer `STREET6_UC_INSTANCE=ksa` for UC→portal inventory reads. Do not assume India or UAE Home Centre `LAND*` codes.

## What to capture next (HAR mind)
1. **On VPN (FortiClient):** DevTools on IBM OMS while downloading pick list, invoice, shipping label for one order (e.g. `403770599`).
2. **Optional without VPN:** after portal password works — HAR for `api/inventory/live` + `api/inventory/upload` (UC→portal inventory path).
3. Sanitize Cookie/Authorization before sharing HARs.

## Automation mapping
| Job step | Source system | Status |
|----------|---------------|--------|
| UC → portal inventory | Seller portal backend above | APIs known; needs working portal login |
| Picklist + invoice + label → email Daniyal | IBM OMS + VPN | Need HAR / Path B files |
