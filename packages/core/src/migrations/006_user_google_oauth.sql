-- Per-user Google Workspace tokens so Packing Mail drafts/sends come from the
-- operator's own Gmail, not a shared mailbox. The shared google_oauth_token (id=1)
-- remains for Sheet Update and shared Drive/Sheets reads.
CREATE TABLE user_google_oauth (
  user_email    text PRIMARY KEY,
  refresh_token text NOT NULL DEFAULT '',
  granted_by    text NOT NULL DEFAULT '',   -- Google account that authorized (usually = user_email)
  scope         text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Scope packing thread memory per user so follow-ups land in THAT user's Gmail thread.
ALTER TABLE packing_threads ADD COLUMN IF NOT EXISTS user_email text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS packing_threads_user_wh_idx ON packing_threads (user_email, warehouse, created_at DESC);
