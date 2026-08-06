# Namshi Seller (UAE + KSA)

**Status:** RE scaffold (`@opptra/connectors-stubs`) · **UI: Coming soon**.

## Capture checklist

Follow **`HAR-CAPTURE-CHECKLIST.md`** — it is the full handoff contract (4 flows, sanitization rules, what makes a capture sufficient). Send the HAR privately, never via git or `#scm-ops`.

## Scaffold state

| Action | Backend | Ready? |
|---|---|---|
| `health.ping` | session/RE | **awaiting HAR** — refuses with `{ code: 'AWAITING_HAR' }` |
| `orders.search` | session/RE | awaiting HAR |
| `inventory.get` | session/RE | awaiting HAR |

## To be filled from the capture

Whether Namshi sellers operate inside noon Seller Lab or a separate Namshi portal (Namshi is a noon-group company since 2023 — see `noon.md`) · UAE vs KSA account/marketplace split · login mechanics · cookie/bearer + headers · request/response shape per flow · pagination · session-death signal.

## Opptra context

If Namshi rides Seller Lab, this connector may become a thin variant of the noon client with a different marketplace/tenant parameter rather than its own reverse-engineered stack.
