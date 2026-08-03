# Amazon Seller Central (India)

**Status:** Scaffold + official SP-API path · **UI: Coming soon (disabled)** · Agent tools blocked until enabled.

## Auth
| Path | Detail |
|---|---|
| **Official (preferred when keys exist)** | SP-API LWA: `AMAZON_SP_CLIENT_ID`, `AMAZON_SP_CLIENT_SECRET`, `AMAZON_SP_REFRESH_TOKEN`. Marketplace `A21TJRUUN4KGV` (amazon.in). Endpoint `https://sellingpartnerapi-eu.amazon.com` (IN is EU region). No SigV4 required for many calls since 2023 — `x-amz-access-token` header. |
| **RE / session (primary until SP-API app approved)** | Seller Central cookie jar (`sellercentral.amazon.in`). Needs sanitized HAR for orders / FBA inventory / labels / returns XHR. |

## Actions (package `@opptra/connectors-amazon`)
| Action | Backend | Ready? |
|---|---|---|
| `health.ping` | SP-API `GET /sellers/v1/marketplaceParticipations` if env set; else awaiting HAR | env-gated |
| `orders.search` | SP-API `GET /orders/v0/orders` | env-gated |
| `inventory.get` | SP-API FBA summaries | env-gated |

## HAR needed
1. Login + session cookies
2. Orders list/detail
3. Inventory / FBA qty
4. Labels / packing slip
5. Returns

## Risks
Portal churn; ToS on session replay; SP-API developer registration + PII/RDT for buyer info.

## Opptra context
Packing Mail already handles Amazon-family labels from Drive; ASN does **not** emit Amazon files (Flipkart/Myntra/Zepto only).
