-- Per-admin ingest tokens: let the "Opptra Session Helper" browser extension POST a
-- freshly-captured JSESSIONID without carrying the admin's web cookie cross-origin.
-- The token is high-entropy, admin-scoped, revocable, and only ever grants
-- session-cookie ingest (nothing else).
CREATE TABLE ingest_tokens (
  id          bigserial PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,        -- sha-256 of the token; raw token shown once
  label       text NOT NULL DEFAULT '',
  owner_email text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used   timestamptz,
  revoked     boolean NOT NULL DEFAULT false
);
CREATE INDEX ingest_tokens_owner_idx ON ingest_tokens (owner_email);

-- Track when a re-login is needed so the UI can prompt loudly and we can measure
-- how long the session was down (an operational metric for the admin panel).
ALTER TABLE uc_session ADD COLUMN needs_relogin boolean NOT NULL DEFAULT false;
ALTER TABLE uc_session ADD COLUMN relogin_since timestamptz;
