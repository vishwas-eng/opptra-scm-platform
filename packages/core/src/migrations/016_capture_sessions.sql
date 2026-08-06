-- Connector capture sessions: a recorded seller-portal login, turned into a blueprint.
--
-- Entries are stored REDACTED (packages/capture/src/redact.js). Live session material
-- is never kept here — it is sealed into connector_credentials at upload time and the
-- copy in the capture is blanked, so this table can be read by an operator or an agent
-- without handing out a working session.

CREATE TABLE capture_sessions (
  id            bigserial PRIMARY KEY,
  capture_uid   text NOT NULL UNIQUE,
  connector_id  text NOT NULL,
  label         text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'recording',  -- recording | ready | failed
  owner_email   text NOT NULL,
  entry_count   int  NOT NULL DEFAULT 0,
  -- Redacted capture entries (JSON array) and the derived blueprint.
  entries       jsonb NOT NULL DEFAULT '[]'::jsonb,
  analysis      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- True once session material was extracted and sealed into connector_credentials.
  session_saved boolean NOT NULL DEFAULT false,
  error         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX capture_sessions_connector_idx ON capture_sessions (connector_id, created_at DESC);
CREATE INDEX capture_sessions_owner_idx ON capture_sessions (owner_email, created_at DESC);
