-- Agent chat threads + messages, plus per-user connector enablement for the Agent tab.
-- Credentials stay in existing vaults (uc_session, google_oauth_token, user_google_oauth, env).

CREATE TABLE agent_threads (
  id           bigserial PRIMARY KEY,
  thread_uid   text NOT NULL UNIQUE,
  user_email   text NOT NULL,
  title        text NOT NULL DEFAULT 'New chat',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_threads_user_idx ON agent_threads (user_email, updated_at DESC);

CREATE TABLE agent_messages (
  id           bigserial PRIMARY KEY,
  thread_id    bigint NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content      text NOT NULL DEFAULT '',
  -- Collapsible tool trace: [{ id, name, args, result, status, error? }]
  tool_calls   jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_messages_thread_idx ON agent_messages (thread_id, id);

-- User opted-in connectors for agent tool use (vault may still be shared/org-level).
CREATE TABLE agent_connector_state (
  user_email     text NOT NULL,
  connector_id   text NOT NULL,
  enabled        boolean NOT NULL DEFAULT false,
  connected_at   timestamptz,
  disconnected_at timestamptz,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_email, connector_id)
);
