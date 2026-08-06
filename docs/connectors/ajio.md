# Ajio Seller

**Status:** RE scaffold (`@opptra/connectors-stubs`) · **UI: Coming soon**.

## Capture checklist

Follow **`HAR-CAPTURE-CHECKLIST.md`** — it is the full handoff contract (4 flows, sanitization rules, what makes a capture sufficient). Send the HAR privately, never via git or `#scm-ops`.

## Scaffold state

| Action | Backend | Ready? |
|---|---|---|
| `health.ping` | session/RE | **awaiting HAR** — refuses with `{ code: 'AWAITING_HAR' }` |
| `orders.search` | session/RE | awaiting HAR |
| `inventory.get` | session/RE | awaiting HAR |

Connector is disabled in the UI and no Agent tool is exposed. It flips to Live only after a real session test against the real portal.

## To be filled from the capture

Which portal Opptra actually sells through (Ajio B2B / seller central variant) · base URL(s) after login · login mechanics (OTP? SSO?) · cookie name(s) + CSRF/tenant headers · request/response shape per flow · pagination model · session-death signal · bot-detection surface.

## Opptra context

Ajio already exists platform-side as a UC B2B channel mapping (`RELIANCE_AJIO_SOR_B2B → 'AJIO'` in automation-sheet/uc-client) — this connector is the seller-portal side of the same channel.
