-- Agent playbooks: saved daily (or manual) automations crafted from chat.
-- Steps are JSON tool calls the worker can replay. Schedule is registered via BullMQ.

CREATE TABLE agent_playbooks (
  id              bigserial PRIMARY KEY,
  playbook_uid    text NOT NULL UNIQUE,
  user_email      text NOT NULL,
  title           text NOT NULL DEFAULT 'Daily automation',
  instruction     text NOT NULL DEFAULT '',
  -- { connectors: string[], steps: [{ tool, args }], schedule?: { kind, hourUtc, cron } }
  definition      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  schedule_kind   text NOT NULL DEFAULT 'manual'
                  CHECK (schedule_kind IN ('manual', 'daily')),
  hour_utc        int NOT NULL DEFAULT 3 CHECK (hour_utc >= 0 AND hour_utc <= 23),
  thread_uid      text,
  last_run_at     timestamptz,
  last_run_status text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_playbooks_user_idx ON agent_playbooks (user_email, updated_at DESC);
CREATE INDEX agent_playbooks_active_idx ON agent_playbooks (status) WHERE status = 'active';
