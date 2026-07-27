-- A single stored refresh token for Gmail/Sheets, granted by a real Workspace user via a
-- normal OAuth consent screen (the org's "Internal" consent screen allows any @opptra.com
-- account to grant these scopes with no Google verification review). This is the fallback
-- path when service-account domain-wide delegation can't be provisioned (blocked on an
-- IAM grant / Workspace Super Admin approval outside this app's control).
CREATE TABLE google_oauth_token (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  refresh_token  text NOT NULL DEFAULT '',
  granted_by     text NOT NULL DEFAULT '',   -- email of the Google account that authorized
  scope          text NOT NULL DEFAULT '',
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO google_oauth_token (id) VALUES (1);
