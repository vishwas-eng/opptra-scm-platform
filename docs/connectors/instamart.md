# Swiggy Instamart

**Status:** RE scaffold · **UI: Coming soon**. Same class as Zepto/Blinkit.

## Capture checklist

Follow **`HAR-CAPTURE-CHECKLIST.md`** — it is the full handoff contract (4 flows, sanitization rules, what makes a capture sufficient). Send the HAR privately, never via git or `#scm-ops`.

## Scaffold state (package `@opptra/connectors-instamart`)

| Action | Backend | Ready? |
|---|---|---|
| `health.ping` | session/RE | **awaiting HAR** — refuses with `{ code: 'AWAITING_HAR' }` |
| `orders.search` | session/RE | awaiting HAR |
| `inventory.get` | session/RE | awaiting HAR |

Connector is disabled in the UI; `POST /api/agent/connectors/instamart/connect` returns 403 and no Agent tool is exposed. It flips to Live only after a real session test against the real portal — never because the scaffold exists.

## To be filled from the capture

Base URL(s) after login · cookie name(s) + CSRF/tenant headers · request/response shape per flow · pagination model · session-death signal (status / redirect / body marker) · bot-detection surface.

## Opptra context

Same quick-commerce class as Zepto and Blinkit — capture slot/dispatch alongside orders, since slotting is what ops actually chase. Note: the sheet marketplace mapping already renders Swiggy/Instamart customers as `Swiggy`.
