# Connector research notes

Companion to `docs/CONNECTOR-MASTER-PLAN.md` and `docs/REVERSE-ENGINEERING-PLAYBOOK.md`.

## Reference docs per live connector

| Connector | Doc |
|---|---|
| Google Sheets | `google-sheets.md` (tools, error codes, edge cases, scheduling) |
| Google Drive | `google-drive.md` (MIME export map, tools) |
| Unicommerce | `unicommerce.md` (action registry ↔ endpoints, session-death signals, export-job contract) |
| Waypoint | `waypoint.md` (Neon schema, filtered query tool, CSV fallback) |
| Google OAuth plumbing | `google.md` · resource binding: `RESOURCE-CONNECTORS.md` |

Shared machinery: `@opptra/agent-connectors` (tool specs + executor + status, used by API chat AND worker playbooks), `@opptra/connectors-sdk` (`connectorError` taxonomy: `AUTH_REQUIRED / AUTH_EXPIRED / SCOPE_MISSING / PERMISSION_DENIED / NOT_BOUND / NOT_FOUND / INVALID_INPUT / RATE_LIMITED / UPSTREAM_ERROR / TIMEOUT / COMING_SOON / NOT_CONNECTED / UNKNOWN_ACTION / AWAITING_HAR`, with `retryable` semantics).

## Agent panel (Beta), live vs coming soon

**LIVE** (Connect enabled, agent tools work when connected):
- Unicommerce
- Waypoint
- Google Sheets (+ **bound spreadsheet resources**)
- Google Drive (+ **bound folder/file resources**)
- Home Centre (Vinculum)

**Coming soon** (visible, Connect disabled, API rejects connect/invoke):
- Amazon, Flipkart, Myntra, Zepto, Blinkit, Instamart, Nykaa, Meesho, **6th Street**

GCC notes: `6thstreet.md` (VPN → picklist/invoice/label email; UC→portal inventory secondary).

Agent tab is **admin-only**.

Resource binding (Layer B): see `RESOURCE-CONNECTORS.md`.