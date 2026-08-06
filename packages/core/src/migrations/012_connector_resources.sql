-- Bound connector resources (Layer B): specific Sheets/Drive items an Agent user may use.
-- Account OAuth stays in user_google_oauth; this table is the Cursor-like "attach this file" list.

CREATE TABLE connector_resources (
  id              bigserial PRIMARY KEY,
  resource_uid    text NOT NULL UNIQUE,
  user_email      text NOT NULL,
  -- Parent account connector: google-sheets | google-drive (future: others)
  connector_id    text NOT NULL,
  kind            text NOT NULL
                  CHECK (kind IN ('spreadsheet', 'drive_folder', 'drive_file')),
  name            text NOT NULL DEFAULT '',
  -- Google spreadsheetId / folderId / fileId
  external_id     text NOT NULL,
  -- Optional: tabs[], url, mimeType, google_email at bind time
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_email, connector_id, external_id)
);
CREATE INDEX connector_resources_user_idx
  ON connector_resources (user_email, connector_id);
CREATE INDEX connector_resources_ext_idx
  ON connector_resources (connector_id, external_id);
