# noon Seller Lab (UAE + KSA)

**Status:** RE scaffold (`@opptra/connectors-stubs`) · **UI: Coming soon**.

## Capture checklist

Follow **`HAR-CAPTURE-CHECKLIST.md`**, it is the full handoff contract (4 flows, sanitization rules, what makes a capture sufficient). Send the HAR privately, never via git or `#scm-ops`.

## Scaffold state

| Action | Backend | Ready? |
|---|---|---|
| `health.ping` | session/RE | **awaiting HAR**, refuses with `{ code: 'AWAITING_HAR' }` |
| `orders.search` | session/RE | awaiting HAR |
| `inventory.get` | session/RE | awaiting HAR |

## To be filled from the capture

Seller Lab base URL(s) after login · whether UAE and KSA are one login with a country/marketplace switch or two accounts (decides one connector instance vs two) · login mechanics (OTP/2FA?) · cookie/bearer + CSRF/tenant headers · request/response shape per flow · pagination · session-death signal.

## Opptra context

noon also publishes official partner APIs for some integrations, during the capture pass, check whether the account has API access in Seller Lab settings; an official token beats cookie RE for longevity. **Namshi is a noon-group company**, expect its seller side to share auth or infrastructure with Seller Lab (see `namshi.md`); one capture session may unlock both.
