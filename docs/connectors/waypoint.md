# Waypoint connector — Opptra's own SO tracker

**Status: LIVE** · Auth: server-side Neon Postgres URL (read-only) · No per-user auth
What Waypoint is: Opptra's internal sale-order tracker (Next.js on Vercel, `https://opptra-so-tracker.vercel.app`, Google SSO via Auth.js) backed by its **own Neon Postgres** — the source of truth for B2B SOs.

## Two access paths

| Path | Status | Detail |
|---|---|---|
| **Neon DB direct (primary)** | LIVE | `WAYPOINT_DB_URL` → dedicated `pg.Pool` (max 3) in `packages/automation-sheet/src/waypointDb.js`. Read-only by contract. |
| HTTP CSV export (fallback) | kept | `GET {WAYPOINT_BASE_URL}/api/export/sales-orders?type=summary&format=csv` with `Cookie: __Secure-authjs.session-token=…` (`WAYPOINT_COOKIE`). Cookie expires — that is why the DB path replaced it. |

## Schema (verified against live DB)

```
SalesOrder(so_code pk, so_status, marketplace, customer_code, dispatch_warehouse_code,
           ship_to_city, so_value, so_creation_date, po_code, suppressed, …)
SoLineItem(so_code fk, brand_name, units, …)
Appointment(so_code fk, appointment_date, appointment_id, created_at, …)
```

`suppressed` is a withdrawal flag, not a status — always filtered `= false`.

## Agent tool

`waypoint_list_orders` — parameterized, SQL-level filtered (no more full-table pull for a 20-row answer):

| Param | SQL clause |
|---|---|
| `soCode` / `poCode` | exact match |
| `status` | `upper(so_status) = upper($n)` (CREATED / PROCESSING / DISPATCHED / …) |
| `customer` | customer code (the value ops treat as “Marketplace” on sheets) |
| `warehouse` | dispatch warehouse code |
| `createdFrom` / `createdTo` | `so_creation_date` bounds |
| `limit` | default 20, tool cap 50, SQL cap 200 |

All values are bound parameters (`buildWaypointSOQuery` — injection-tested); rows map through `mapNeonRow` to the same Waypoint-CSV key shape the sheet pipeline uses (`SO Code`, `SO Status`, `PO Code`, `Warehouse`, `Customer`, `Marketplace`, `Brand(s)`, `Total Units`, `SO Value`, `Created Date`, `Ship-to City`, `Appt Date`, `Appt ID`).

Health: `pingWaypointDb` (`SELECT count(*) FROM "SalesOrder"`) — a bad URL now fails loudly instead of “ready because the env var exists”.

## Config

| Key | Purpose |
|---|---|
| `WAYPOINT_DB_URL` | Neon connection string (primary; required for the connector to be systemReady) |
| `WAYPOINT_BASE_URL` | portal base for the CSV fallback |
| `WAYPOINT_COOKIE` | Auth.js session cookie for the CSV fallback only |

## Roadmap

- `salesOrder.lineItems` / `appointment.list` reads (schema already supports; appointment-expiry detection is wanted by AGENT-PLATFORM-PLAN)
- Status-exception feed (stuck PROCESSING, appointment expired)
- Columns the portal exports but the SQL doesn't select yet (likely present): `Appt Status`, `PO Expire Date`, `Customer GSTIN`, `Vendor`, `Channel ID`, `Cancelled Value`, `Original Value`, `Delivered At`, `Synced At` — verify against live DB before selecting.
