# Google Sheets & Drive — per-user OAuth for Agent

**Audience:** Opptra SCM Agent · Beta (admin UI today; token model is per-user for future ops users).  
**Does not replace** the shared service-account / shared OAuth used by platform Sheet Update & packing shared Drive reads.

## Architecture

| Path | Used by | Storage |
|---|---|---|
| **Per-user OAuth (Layer A)** | Agent Sheets/Drive tools, Packing Mail Gmail | `user_google_oauth` (keyed by `user_email`) |
| **Bound resources (Layer B)** | Agent tool allow-list (specific spreadsheet / folder / file) | `connector_resources` |
| **Shared OAuth / SA+DWD** | Sheet Update automation, shared Master sheet | `google_oauth_token` id=1 + `GOOGLE_SA_*` env |

See **`docs/connectors/RESOURCE-CONNECTORS.md`** for how individual sheet/drive connectors work.

Per-user refresh tokens are AES-256-GCM encrypted at rest (`enc1:` prefix, key derived from `JWT_SECRET`). Legacy plaintext rows still decrypt/read; re-connect rewrites encrypted. Tokens never leave the API/worker to the browser.

Agent tools **never** fall back to the service account. If the user has no personal grant, tools return “Connect Google” with `/auth/google/connect?return=connectors`. After OAuth, **bind** each spreadsheet/folder the Agent may use — discovery (`sheets_list_spreadsheets`) does not unlock read/write.

## Connect flow

1. Admin opens **Connectors** → Google Sheets or Drive → **Connect Google**
2. Browser hits `GET /auth/google/connect?return=connectors`
3. Google consent (forced `prompt=consent` so refresh_token is returned)
4. Callback `GET /auth/google/callback` stores refresh token under the signed-in Opptra user
5. Redirect `/?googleConnect=ok&tab=connectors`

Same grant covers Packing Mail (Gmail compose/send) + Agent Sheets + Agent Drive.

## Google Cloud Console — exact URLs

OAuth client type: **Web application**

**Authorized JavaScript origins**
- `https://scm.opptra.com`

**Authorized redirect URIs**
- `https://scm.opptra.com/auth/google/callback`

Also required on the VM `.env`:
- `PUBLIC_URL=https://scm.opptra.com`
- `GOOGLE_CLIENT_ID=…`
- `GOOGLE_OAUTH_CLIENT_SECRET=…`

## Scopes requested

From `@opptra/integrations-google` `SCOPES`:
- `gmail.compose`, `gmail.send` (Packing)
- `drive.readonly` (Agent Drive list/download + list spreadsheets)
- `spreadsheets` (Agent read/write ranges)

## Edge cases handled

| Breakage | Mitigation |
|---|---|
| No refresh_token on re-auth | `prompt=consent` always; clear message to revoke at myaccount.google.com/permissions |
| Missing Sheets/Drive scopes | `userGoogleScopeStatus` → status `needs_reconnect`, Connectors UI “Reconnect” |
| Wrong Google account vs Opptra login | Store `google_email`; warn via `googleMismatch` query + Connectors hint |
| Can view sheet but not edit | Catch 403 / PERMISSION_DENIED → clear “share edit access or reconnect” |
| Token revoked mid-job | Catch `invalid_grant` → mark `last_error`, ask reconnect; optional clear |
| Rate limits / quota | Existing `withGoogleRetry` + tool error `rateLimited` |
| Multi-tab OAuth | In-memory `state` map (10 min TTL); expired state → “open Connect from one tab” |
| Disconnect | Clears `user_google_oauth` for that user (also removes Packing Gmail grant) |
| Platform Sheet Update | Unchanged — still shared SA / shared OAuth |

## API

- `GET /api/me/google/status` — connected, scopes, mismatch, `connectUrl`
- `POST /api/me/google/disconnect` — revoke per-user token
- Agent: `POST /api/agent/connectors/google-sheets/connect` enables both Sheets+Drive prefs once OAuth exists
- Resources: `GET|POST /api/agent/connectors/{google-sheets|google-drive}/resources`, `DELETE …/resources/:resourceUid`

## UX

- **Connectors** page: marketplace grid (live + coming soon)
- Under Sheets / Drive detail: **Add spreadsheet** / **Add folder** list with Remove
- **Agent** chat: clean composer + “Tools” summary + **Manage connectors** (no wall of disabled cards)
