# Resource connectors (Layer B)

**How individual Google Sheet / Drive connectors work for Opptra SCM Agent · Beta.**

Companion: `docs/connectors/google.md`, `docs/CONNECTOR-MASTER-PLAN.md`.

## Model (Cursor-like)

```
Layer A, Account connector
  Connect Google OAuth (per-user) → Sheets + Drive scopes
        ↓
Layer B, Resource connectors (this doc)
  Bind specific spreadsheet / folder / file IDs the Agent may touch
        ↓
Layer D, Agent tools
  sheets_read / sheets_write / drive_list / drive_download
  only resolve against bound resources (+ discovery list tools)
```

Same pattern as Cursor: connect the account, then attach specific projects/files.

Platform Sheet Update / packing shared Drive still use the **shared** SA / shared OAuth. Agent tools **never** fall back to the service account.

## What gets stored

Table `connector_resources`:

| Field | Meaning |
|---|---|
| `resource_uid` | Stable id for Agent / playbooks (`resourceId`) |
| `user_email` | Owner (Opptra login) |
| `connector_id` | `google-sheets` or `google-drive` |
| `kind` | `spreadsheet` \| `drive_folder` \| `drive_file` |
| `name` | Display label (from Google title when possible) |
| `external_id` | Google spreadsheetId / folderId / fileId |
| `meta` | tabs[], url, mimeType, googleEmail at bind time |

OAuth tokens stay in `user_google_oauth`. Resources are only the allow-list.

## Bind flow

1. Connectors → Google Sheets or Drive → **Connect Google** (if needed)
2. Paste spreadsheet / folder / file URL or raw id → **Add spreadsheet** / **Add folder**
3. API verifies access with the **per-user** refresh token, stores name + id
4. Agent tools accept `resourceId` (preferred) or a already-bound `spreadsheetId` / `folderId` / `fileId`

### URL shapes accepted

- `https://docs.google.com/spreadsheets/d/{ID}/…`
- `https://drive.google.com/drive/folders/{ID}`
- `https://drive.google.com/file/d/{ID}/…`
- Raw Google id (10–128 chars)

## Agent tools

| Tool | Scope |
|---|---|
| `sheets_list_bound` / `drive_list_bound` | Bound resources only |
| `sheets_list_spreadsheets` / `drive_search` | OAuth discovery, **does not** unlock read/write |
| `sheets_read` / `sheets_write` / `sheets_append_rows` / `sheets_copy_range` | Bound spreadsheets only |
| `drive_list` / `drive_download` | Bound folders / files only |

Aliases: `sheets.read`, `sheets.write`, `drive.list`, `drive.download`.

Daily automations (`/api/agent/playbooks`) should store `resourceId` in step args so replays stay stable if someone renames the sheet.

**Automate daily (Agent UI):** after a chat uses tools, open the schedule bar → name + UTC hour → registers a BullMQ `upsertJobScheduler` cron (`0 {hour} * * *`). Pause removes the scheduler. Run triggers `agent.playbook.run` immediately.

## API

```http
GET    /api/agent/connectors/google-sheets/resources
POST   /api/agent/connectors/google-sheets/resources
       { "name": "Master ops", "url": "https://docs.google.com/spreadsheets/d/…" }
DELETE /api/agent/connectors/google-sheets/resources/:resourceUid

GET    /api/agent/connectors/google-drive/resources
POST   /api/agent/connectors/google-drive/resources
       { "url": "https://drive.google.com/drive/folders/…", "kind": "drive_folder" }
DELETE /api/agent/connectors/google-drive/resources/:resourceUid
```

Admin-only (Agent Beta). Disconnecting Google clears bound resources by default (`clearResources: false` to keep the list).

## Edge cases

| Case | Behaviour |
|---|---|
| **Wrong Google account** | Bind fails with permission/not-found, or Connectors shows `accountMismatch` vs Opptra login |
| **Can view but not edit** | Read may work; write returns 403 → share edit access or reconnect with correct account |
| **Revoked / expired refresh token** | Tools return reconnect + `/auth/google/connect?return=connectors`; `last_error` set on `user_google_oauth` |
| **Missing Sheets/Drive scopes** | Status `needs_reconnect`; bind rejected until reconnect with `prompt=consent` |
| **Unbound spreadsheetId in tool call** | `{ ok: false, bindRequired: true }`, add under Connectors first |
| **Disconnect Google** | Clears OAuth + Sheets/Drive prefs + bound resources (unless `clearResources: false`) |
| **Platform Sheet Update** | Unchanged, shared SA / shared OAuth; not this table |

## Security

- Per-user tokens encrypted at rest; never returned to the browser
- Agent never uses shared Master SA for these tools
- Bound list is per Opptra user email, no cross-user resource share yet
- Marketplace connectors remain coming soon (no fake Amazon login)
