# Google Drive connector, n8n-grade reference

**Status: LIVE** · Auth: per-user OAuth2 (official API, `drive.readonly`)
Companions: `google.md` (OAuth plumbing), `google-sheets.md`, `RESOURCE-CONNECTORS.md`.

## Base URLs & scopes

| What | Value |
|---|---|
| API base | `https://www.googleapis.com/drive/v3` (via `googleapis` client) |
| Media download | `files.get` with `alt=media` |
| Google-native export | `files.export` with target MIME |
| Scope | `https://www.googleapis.com/auth/drive.readonly` (read-only by design, upload is a future scope bump) |

Same per-user OAuth grant as Sheets; same encryption; Agent never uses the shared SA.

## Resource model

Bind folders (`kind='drive_folder'`) or single files (`kind='drive_file'`) under Connectors → Google Drive. `drive_list` requires a bound **folder**; `drive_download`/`drive_get_file_meta` accept a bound file (or a file inside… no, the file itself must be bound; listing a bound folder surfaces ids which can then be bound). Unbound ids → `NOT_BOUND`.

## MIME export map (drive_download)

| Source MIME | Handling |
|---|---|
| `application/vnd.google-apps.document` | `files.export` → `text/plain` |
| `application/vnd.google-apps.spreadsheet` | `files.export` → `text/csv` |
| `text/*`, `*json*`, `*csv*`, `*xml*` or name `.csv/.txt/.json/.tsv` | `files.get alt=media` (bytes → utf8) |
| anything else (binary/PDF/images) | refused with `INVALID_INPUT`, use `drive_get_file_meta`; binary download lands with the GCS artifact pattern later |

Preview truncation: `maxChars` default 8 000, hard cap 20 000, `truncated: true` flagged.

## Agent tools

| Tool | Drive API call | Mutates |
|---|---|---|
| `drive_list_bound` |, (DB read) | no |
| `drive_search` | `files.list` (`q` escaped via `escapeDriveQuery`, backslash + quote escaping, injection-safe) | no |
| `drive_list` / `drive_list_folder` | `files.list` `'folder' in parents` | no |
| `drive_get_file_meta` | `files.get` (fields subset) | no |
| `drive_download` / `drive_read_text_file` | `files.get` / `files.export` | no |

## Errors

Identical taxonomy to Sheets (`google-sheets.md` table): `AUTH_REQUIRED`, `AUTH_EXPIRED`, `SCOPE_MISSING`, `PERMISSION_DENIED`, `NOT_FOUND`, `NOT_BOUND`, `RATE_LIMITED` (retryable), `UPSTREAM_ERROR` (retryable). All produced by the shared `mapGoogleToolError`.

## E2E verification checklist

1. Connect Google (same grant as Sheets).
2. Bind a Drive folder by URL.
3. `drive_list` → files with ids.
4. Bind a CSV from that folder, `drive_download` → text preview.
5. Pipeline: download CSV → `sheets_append_rows` into a bound sheet → **Automate daily**.
