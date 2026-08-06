# HAR capture checklist — what a human must send us per marketplace

Every "Coming soon" connector is blocked on exactly one thing: a **logged-in HAR** from someone with a real seller account. This is the handoff contract. Follow it once per platform and the connector can go from scaffold to Live.

Companion: `docs/REVERSE-ENGINEERING-PLAYBOOK.md` (HAR → action recipe, engineering side).

---

## 1. Capture (15 minutes, one person, one browser profile)

1. Chrome → the seller portal → **log in normally** (solve any CAPTCHA/OTP yourself; we never automate that).
2. Open **DevTools → Network**. Tick **Preserve log**. Tick **Disable cache**.
3. Filter to **Fetch/XHR**.
4. Now click through these four flows **in this order**, pausing ~2 s between each so requests group cleanly:

   | # | Flow | What to actually click |
   |---|---|---|
   | 1 | **Orders** | Open the orders/PO list. Change a filter (status or date). Go to page 2. Open ONE order's detail. |
   | 2 | **Inventory** | Open inventory/listings. Search one SKU. |
   | 3 | **Labels / shipments** | Open a shipment, generate or view a label / packing slip / invoice (do NOT dispatch anything real). |
   | 4 | **Returns** | Open the returns/claims list. Open one return if there is one. |

5. Right-click anywhere in the Network list → **Save all as HAR with content**.
6. Also note, in a plain text message: the **exact URL** of the seller home page after login, and whether login used OTP, password, or SSO.

---

## 2. Sanitize before sending (required)

A raw HAR contains live session cookies and often PII. **Do not commit it to git, ever.**

- Send the HAR through a **private** channel (direct file transfer to the engineer), not `#scm-ops`, not a PR.
- We store live cookies only in the encrypted session vault; the HAR itself is used locally, then deleted.
- If the portal shows customer names/addresses/phones, say so — we redact those fields before any fixture is checked in.
- Fixtures that DO get committed are hand-sanitized: real ids replaced, all `Cookie` / `Authorization` / `set-cookie` headers stripped.

---

## 3. What we extract from it (so you know it was enough)

For each critical XHR we record: base URL, path, method, request headers that matter (cookie names, CSRF token header, tenant/seller id headers), query params, request body schema, response body **shape** (key names, not values), pagination model, and the failure signal when the session dies (status code / redirect / error body marker).

**Your capture is sufficient if** each of the four flows produced at least one XHR to the portal's own API host (not just static assets). If flow N shows only HTML document loads, that portal renders server-side for that screen and we need a different approach — tell us and we will adjust.

---

## 4. Per-platform status

| Platform | Login URL (verify at capture time) | What we still need |
|---|---|---|
| **Amazon Seller Central IN** | `sellercentral.amazon.in` | HAR for all 4 flows. **Prefer SP-API**: if developer registration completes, send LWA client id/secret/refresh token instead and we swap the adapter with no capability-id change. |
| **Flipkart Seller Hub** | `seller.flipkart.com` | HAR for all 4 flows. Seller API keys, if approved, replace the RE path later. |
| **Myntra Partner** | Partner portal (access-gated) | HAR for orders/PO + ASN acceptance. ASN XLSX generation already exists in `automation-asn`. |
| **Zepto Vendor** | Vendor portal (access-gated) | HAR for PO/orders status, inventory, and whether ASN/label upload happens in the UI. Zepto CSV is already emitted from UC. |
| **Blinkit Seller** | Seller portal (access-gated) | HAR for orders, inventory, dispatch status. |
| **Swiggy Instamart** | Partner portal (access-gated) | HAR for orders, inventory, slot/dispatch. |
| **Nykaa Seller** | Seller portal | HAR for orders, inventory, labels, returns. |
| **Meesho Supplier** | `supplier.meesho.com` | HAR for orders, inventory, returns. |
| **6th Street** | `seller-portal.6thstreet.com` (+ IBM OMS behind VPN) | **After VPN:** (1) pick list Excel download (2) invoice PDF (3) shipping label PDF (4) inventory upload/update. Login: portal and/or `apg-oms.prod.coc.ibmcloud.com`. See `6thstreet.md`. |

Login URLs above are the public entry points; confirm the exact host you land on after login and report it — several of these redirect to a tenant-specific subdomain, and that host is what the connector must call.

---

## 5. Known risks we will document per platform once captured

- **Bot detection / WAF** (Akamai, PerimeterX, Cloudflare): shows up as 403s on replay with a valid cookie. Mitigation is matching headers exactly and staying at human request rates — never volume.
- **Session lifetime**: most seller portals idle out in minutes to hours. Every connector gets a keepalive ping + honest "re-paste session" surfacing, exactly like Unicommerce.
- **Portal churn**: RE endpoints break when the vendor ships a redesign. The action registry isolates that to one handler per capability.
- **ToS**: RE session replay is ops-owned, rate-limited, and read-mostly. Mutating actions ship only with explicit approval.

---

## 6. Until a HAR lands

The connector stays **Coming soon** in the UI, `POST /api/agent/connectors/:id/connect` returns 403, and every scaffolded action returns the structured error `{ code: 'AWAITING_HAR', retryable: false }`. That refusal is deliberate — a connector that pretends to work is worse than one that says it does not.
