# Home Centre (Vinculum) — GCC

Manual automation on `scm.opptra.com` under the **GCC** region toggle.

## What it does

1. **Sync (UC punch only):** list Vinculum active orders → create UC customer → create B2C sale order. No UC allocate/invoice/dispatch.
2. **Fulfill (Vinculum):** confirm → invoice → ready → ship → download label — requires `VINCULUM_FULFILL_ACTIONS_JSON` after HAR capture (not required for empty testing).

## Testing with zero orders

- Cron is **disabled** (manual only).
- Dry-run + empty list returns **success** (`empty: true`, “No Home Centre orders…”).
- Missing Vinculum creds still returns success with `configured: false` (ready message, no crash).

## Env

```
VINCULUM_BASE_URL=https://landmarkgroup.vinsupplier.com/eRetailWeb
VINCULUM_USER=
VINCULUM_PASS=
HC_SYNC_MINUTES=0
HC_UC_CHANNEL=CUSTOM
HC_UC_CURRENCY=AED
HC_UC_FACILITY=
HC_SKU_MAP_JSON=
VINCULUM_FULFILL_ACTIONS_JSON=
```

Keep `HC_SYNC_MINUTES=0` until you want a schedule.
