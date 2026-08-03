-- Agent Google OAuth metadata (per-user). Tokens stay in user_google_oauth;
-- this tracks Agent-specific health without changing Packing Mail's table shape.
ALTER TABLE user_google_oauth
  ADD COLUMN IF NOT EXISTS last_error text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_ok_at timestamptz,
  ADD COLUMN IF NOT EXISTS google_email text NOT NULL DEFAULT '';

-- Backfill google_email from granted_by when blank.
UPDATE user_google_oauth SET google_email = granted_by
WHERE google_email = '' AND granted_by <> '';
