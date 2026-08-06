# Connecting a channel

Three ways in, picked by what the channel actually offers. The operator never hands over
a password, and never reads a HAR.

| Path | Channels | What the operator does |
|---|---|---|
| **Official OAuth** | Amazon (IN/UAE/KSA) | Click Connect → approve on Amazon's own consent page. Done forever. |
| **Live capture** | Every portal with no public API, Myntra, Nykaa, Ajio, noon, Namshi, 6th Street, Meesho, quick-commerce | Click Start in the Capture extension, log in, click through Orders / Inventory / one shipment, click Stop. |
| **Session paste** | Unicommerce | One-click JSESSIONID capture (unchanged). |

## 1. Official OAuth, Amazon

`/auth/amazon/connect?marketplace=in|ae|sa` redirects to that region's Seller Central
consent page; the callback exchanges the one-time code for a refresh token which is
sealed into the connector vault. Access tokens are minted on demand.

**Server prerequisite (one time):** create an SP-API app in Seller Central →
Develop Apps, then set `AMAZON_APP_ID`, `AMAZON_SP_CLIENT_ID`, `AMAZON_SP_CLIENT_SECRET`.

## 2. Live capture, how it works

```
Operator clicks Start
      │
      ▼
Extension opens the portal, records request metadata for THAT portal's hosts only
      │  (batched every 2.5 s)
      ▼
POST /api/capture/sessions/:uid/entries
      │
      ├─ 1. extract session material  ──▶ sealed into connector_credentials (AES-256-GCM)
      ├─ 2. redact every entry        ──▶ stored capture carries no working credential
      ▼
POST …/finish  ──▶ analyzeCapture()  ──▶ blueprint
                                         · primary host (vs CDN / analytics noise)
                                         · auth model: session cookie name, bearer, CSRF
                                           and tenant headers, the login request
                                         · endpoints as path templates, with call counts,
                                           status mix, query keys, payload SHAPES
                                         · candidate action ids (orders.search, …)
```

What is deliberately **not** captured: passwords (never in a request we record, they go
in the login POST body, which is redacted key-wise before storage), and response bodies
(MV3 `webRequest` cannot observe them, see the HAR path below when shapes matter).

### What makes a good capture

Log in, then visit each screen **once**: Orders list → open one order → Inventory →
one shipment/label. Two minutes of clicking is a complete blueprint. More clicking adds
nothing; the analyzer collapses repeats into one endpoint with a call count.

## 3. HAR upload, when response shapes matter

`POST /api/capture/har?connectorId=<id>` with the `.har` as multipart `file`. Same
pipeline, and HAR *does* carry response bodies, so the blueprint gains full response
shapes.

⚠️ Chrome's **"Save all as HAR (sanitized)"** strips `Cookie`/`Set-Cookie` entirely. The
analysis still works, but no session is obtained, the blueprint says so explicitly
(`auth.warning`). Use the extension for the session, or export unsanitized.

## Reading the blueprint

`GET /api/capture/sessions/:uid` returns `analysis`:

- `summary.primaryHost`, the API host to point the client at
- `auth.sessionCookie` / `auth.bearer` / `auth.customHeaders`, how to carry the session
- `auth.loginRequest`, the login endpoint, for scripted re-login later
- `endpoints[]`, `{ method, path, calls, statuses, queryKeys, requestShape, responseShape }`
- `suggestedActions[]`, endpoints that map to a known capability id

That is everything `createRegistry().register()` needs. The channel graduates from
`@opptra/connectors-stubs` to its own package, and the moment it does it appears in the
web app, the Agent chat, and every MCP client, no per-surface work.

## Security notes

- Captures are redacted **before** the first write; secret-shaped values are scrubbed
  even under innocent keys, and JSON *shape* is preserved while secret leaves are not.
- Session material goes to `connector_credentials`, sealed with AES-256-GCM.
- Recording is scoped to the selected channel's hosts, a capture never sweeps up
  unrelated browsing.
- Captures are per-user and audited (`capture-start` / `capture-finish` / `capture-delete`).
- Delete a capture once its connector is built: `DELETE /api/capture/sessions/:uid` (admin).
