-- Generic connector credential vault (session cookies, OAuth tokens, API keys).
-- Never expose secret_enc to the browser; API returns only metadata + connected flags.

CREATE TABLE connector_credentials (
  id              bigserial PRIMARY KEY,
  connector_id    text NOT NULL,
  -- 'shared' for org bot account; otherwise user email for per-user grants
  owner_key       text NOT NULL DEFAULT 'shared',
  auth_kind       text NOT NULL DEFAULT 'session'
                  CHECK (auth_kind IN ('session', 'oauth2', 'apikey', 'bearer', 'basic', 'dual')),
  -- Opaque secret blob (cookie string, refresh token, JSON). Never log / never return raw.
  secret_enc      text NOT NULL DEFAULT '',
  -- Non-secret metadata (marketplace id, account label, scopes, cookie names, …)
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'unknown'
                  CHECK (status IN ('unknown', 'alive', 'dead', 'configured')),
  source          text NOT NULL DEFAULT 'none',
  updated_by      text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_ok_at      timestamptz,
  last_check_at   timestamptz,
  fail_count      int NOT NULL DEFAULT 0,
  UNIQUE (connector_id, owner_key)
);
CREATE INDEX connector_credentials_conn_idx ON connector_credentials (connector_id);
