# Google Sheets connector — n8n-grade reference

**Status: LIVE** · Auth: per-user OAuth2 (official API) · Package surface: `@opptra/agent-connectors` tools + `@opptra/integrations-google` wrappers
Companions: `google.md` (OAuth plumbing + Cloud Console setup), `RESOURCE-CONNECTORS.md` (Layer-B binding), `google-drive.md`.

## Base URLs & scopes

| What | Value |
|---|---|
| API base | `https://sheets.googleapis.com/v4` (via `googleapis` npm client) |
| Discovery base (spreadsheet listing) | `https://www.googleapis.com/drive/v3` |
| Token endpoint | `https://oauth2.googleapis.com/token` |
| Scopes requested | `spreadsheets`, `drive.readonly`, `gmail.compose`, `gmail.send` (one grant powers Sheets + Drive + Packing Mail) |
| Scope needed by this connector | `https://www.googleapis.com/auth/spreadsheets` (read+write), `drive.readonly` for discovery |

Auth mode for Agent tools is **always the signed-in user's own refresh token** (`user_google_oauth` row, AES-256-GCM at rest). The platform's shared SA / shared OAuth is never used by Agent tools — the Agent can only touch what the human's own Google account can touch.

## Resource model (Layer B)

Users bind specific spreadsheets under **Connectors → Google Sheets → Add spreadsheet** (URL or raw id). Bindings live in `connector_resources` (`kind='spreadsheet'`, unique per `user_email + connector_id + external_id`). Every read/write tool resolves `resourceId` (preferred) or a raw `spreadsheetId` **that must already be bound** — an unbound id returns `NOT_BOUND` with a bind hint, never a silent read.

Discovery (`sheets_list_spreadsheets`) lists what OAuth can see but does **not** unlock read/write.

## Agent tools (registered in `packages/agent-connectors/src/tools.js`)

| Tool | Sheets API call | Mutates |
|---|---|---|
| `sheets_list_bound` | — (DB read) | no |
| `sheets_list_spreadsheets` | `drive.files.list` (mimeType filter) | no |
| `sheets_list_tabs` | `spreadsheets.get` (fields=sheets.properties.title) | no |
| `sheets_read` / `sheets_get_range` | `spreadsheets.values.get` | no |
| `sheets_write` / `sheets_update_range` | `spreadsheets.values.update` (USER_ENTERED) | **yes** |
| `sheets_append_rows` | `spreadsheets.values.append` (USER_ENTERED) | **yes** |
| `sheets_clear_range` | `spreadsheets.values.clear` | **yes** |
| `sheets_copy_range` | `values.get` → `values.update` (within user ACL) | **yes** |

Aliases: `sheets.read`, `sheets.write`, `sheets.append`, `sheets.clear` map to the underscore names. Mutating set is exported as `MUTATING_TOOLS`.

**Write clamps:** 200 rows × 50 cols × 500 chars/cell per call (`clampRows`). Reads return max 80 rows per call with `totalRows` + `truncated: true` when clipped — the truncation is explicit, never silent.

## Error contract (mapped in `packages/agent-connectors/src/google.js`)

All failures use the shared shape `{ ok:false, code, error, retryable, ...hints }` from `@opptra/connectors-sdk`:

| Upstream signal | `code` | retryable | UX hint |
|---|---|---|---|
| No refresh token stored | `AUTH_REQUIRED` | no | `oauthUrl` → `/auth/google/connect?return=connectors` |
| `invalid_grant` / token revoked | `AUTH_EXPIRED` | no | `reconnect: true` + `oauthUrl` |
| Grant missing Sheets/Drive scope | `SCOPE_MISSING` | no | `reconnect: true` + `oauthUrl` |
| HTTP 403 `PERMISSION_DENIED` / view-only sheet | `PERMISSION_DENIED` | no | share edit access or reconnect correct account |
| HTTP 404 / file not found | `NOT_FOUND` | no | check link / wrong Google account |
| HTTP 429 / quota / `userRateLimit` | `RATE_LIMITED` | **yes** | wait and retry |
| 5xx / transport | `UPSTREAM_ERROR` | **yes** | — |
| Unbound spreadsheetId | `NOT_BOUND` (from resolver) | no | bind under Connectors |

Additionally `withGoogleRetry` (integrations-google) retries 429/quota-403/5xx up to 5× with exponential backoff + jitter **before** the error ever reaches the mapper — the mapped error means retries were already exhausted.

## Edge cases covered

- **Missing/revoked refresh token** → Reconnect UX (`AUTH_EXPIRED`, `markUserGoogleOAuthError` records the reason; Connectors panel shows `needs_reconnect`).
- **Insufficient scopes** → `userGoogleScopeStatus` gate at connect time AND at every tool call (`SCOPE_MISSING`).
- **View-only sheet** → `PERMISSION_DENIED` (writes fail, reads still work if readable).
- **Wrong Google account connected** → `accountMismatch` surfaces on the Connectors panel (`Connected as x@gmail.com (differs from login)`); binding verifies access with the *user's* token at bind time.
- **Quota 429** → retry-with-backoff, then `RATE_LIMITED` (retryable).
- **Large ranges** → read cap 80 rows returned + `truncated` flag; write cap 200×50×500.
- **Concurrent writes** → last-write-wins at Google's layer; playbook steps run serially inside the concurrency-1 worker, and chat tool calls run sequentially per turn. No optimistic-lock API exists in values.update; for contended tabs use `sheets_append_rows` (append is atomic server-side).
- **IMPORTRANGE mirrors** — platform rule: the Master sheet mirror is never overwritten. That guard lives in the Sheet Update automation (`readFormulas` detection); Agent users can only bind sheets they own/edit.

## Scheduling

“Every day do X on sheet Y” → Agent chat proposes steps → **Automate daily** saves an `agent_playbooks` row (definition = tool steps) → BullMQ job scheduler `agent-playbook-<uid>` (cron `0 <hourUtc> * * *`) → worker `agent.playbook.run` replays the steps through the same executor with per-user OAuth. Runs appear in the Runs ledger (`automation='agent-playbook'`); failures carry the structured step error.

## E2E verification checklist

1. Connect personal Google on Connectors (consent screen; refresh token stored encrypted).
2. Bind a spreadsheet by URL — title + tabs resolved with the user token.
3. Chat: `read <name> A1:G20` → `sheets_read` returns rows.
4. Chat: append a row → verify in the sheet.
5. Automate daily at chosen hour → scheduler registered; run history visible next morning.
6. Revoke access at myaccount.google.com/permissions → next tool call returns `AUTH_EXPIRED` with reconnect URL, Connectors shows needs_reconnect.
