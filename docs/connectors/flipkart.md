# Flipkart Seller Hub

**Status:** Scaffold + official Seller API path · **UI: Coming soon** · Agent tools blocked.

## Auth
| Path | Detail |
|---|---|
| **Official** | OAuth2 client credentials / auth code → Bearer. Env: `FLIPKART_APP_ID`, `FLIPKART_APP_SECRET`, optional `FLIPKART_ACCESS_TOKEN`. Base `https://api.flipkart.net/sellers`. Docs: seller.flipkart.com/api-docs |
| **RE / session** | Seller Hub browser session — HAR required for portal XHR not covered by API. |

## Actions
| Action | Ready? |
|---|---|
| `health.ping` | Token probe when `FLIPKART_*` set |
| `orders.search` | `POST /v3/shipments/filter` when token set |
| `inventory.get` | Awaiting location IDs / HAR |

## HAR needed
Orders, inventory locations, labels/shipments, returns.

## Opptra context
`automation-asn` already writes Flipkart packaging XLSX from UC sale orders.
